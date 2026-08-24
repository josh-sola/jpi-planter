import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JpiBackgroundTaskMonitor } from "../extensions/jpi-planter/background.ts";
import {
  JPI_BACKGROUND_ID_PREFIX,
  jpiBackgroundRunningTasks,
  jpiBackgroundTasksLevel,
  jpiBackgroundTerminalId,
} from "../extensions/jpi-planter/protocol.ts";
import {
  PlanterEventBus,
  backgroundRequests,
  backgroundResponse,
  jpiBackgroundRequests,
  jpiBackgroundStatusResponse,
  jpiBackgroundTasksPayload,
  jpiBackgroundTerminalPayload,
  planterHarness,
  readRecord,
} from "./jpi-planter-test-helpers.ts";

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "jpi-planter-jpi-background-"));
}

function namespaced(id: string) {
  return `${JPI_BACKGROUND_ID_PREFIX}${id}`;
}

test("jpi-background status responses validate, namespace ids, and dedupe", () => {
  const parsed = jpiBackgroundRunningTasks({
    schema: "jpi-background.response.v1",
    request_id: "request",
    operation: "status",
    ok: true,
    result: { tasks: [
      { kind: "task", id: "abc", status: "running" },
      { kind: "task", id: "abc", status: "running" },
      { kind: "monitor", id: "mon", status: "running" },
      { kind: "task", id: "done", status: "completed" },
    ] },
  }, "request");
  assert.deepEqual([...parsed!.values()], [
    { id: namespaced("abc"), isAgent: false },
    { id: namespaced("mon"), isAgent: false },
  ]);

  for (const malformed of [
    null,
    {},
    { schema: "wrong" },
    { schema: "jpi-background.response.v1", request_id: "other", operation: "status", ok: true, result: { tasks: [] } },
    {
      schema: "jpi-background.response.v1",
      request_id: "request",
      operation: "status",
      ok: true,
      result: { tasks: [{ kind: "task", id: "bad-status", status: "not-a-status" }] },
    },
    {
      schema: "jpi-background.response.v1",
      request_id: "request",
      operation: "status",
      ok: true,
      result: { tasks: [{ kind: "monitor", id: "bad-status", status: "completed" }] },
    },
  ]) {
    assert.equal(jpiBackgroundRunningTasks(malformed, "request"), undefined);
  }
});

test("jpi-background tasks:v1 is a full replace-set, including clearing to empty", () => {
  const populated = jpiBackgroundTasksLevel(jpiBackgroundTasksPayload([
    { kind: "task", id: "abc", status: "running" },
    { kind: "monitor", id: "mon", status: "exited" },
  ]));
  assert.deepEqual([...populated!.values()], [{ id: namespaced("abc"), isAgent: false }]);

  const cleared = jpiBackgroundTasksLevel(jpiBackgroundTasksPayload([]));
  assert.deepEqual([...cleared!.values()], []);

  assert.equal(jpiBackgroundTasksLevel({ schema: "wrong", tasks: [] }), undefined);
  assert.equal(jpiBackgroundTasksLevel(jpiBackgroundTasksPayload([{ kind: "task", id: "x" } as never])), undefined);
});

test("jpi-background terminal broadcasts resolve to a namespaced id only when terminal", () => {
  assert.equal(
    jpiBackgroundTerminalId(jpiBackgroundTerminalPayload({ kind: "task", id: "abc", status: "failed" })),
    namespaced("abc"),
  );
  assert.equal(
    jpiBackgroundTerminalId(jpiBackgroundTerminalPayload({ kind: "monitor", id: "mon", status: "running" })),
    undefined,
  );
  assert.equal(jpiBackgroundTerminalId({ schema: "wrong", task: { kind: "task", id: "abc", status: "failed" } }), undefined);
});

test("the monitor is push-only: one initial request, replace-set updates, and deduped terminal removals", () => {
  const events = new PlanterEventBus();
  const applied: Array<Array<{ id: string; isAgent: boolean }>> = [];
  const monitor = new JpiBackgroundTaskMonitor(events, () => "req-1", (tasks) => applied.push([...tasks.values()]));
  monitor.start();

  assert.deepEqual(jpiBackgroundRequests(events), [{
    schema: "jpi-background.request.v1",
    request_id: "req-1",
    operation: "status",
    params: {},
  }]);

  events.emit("jpi-background:tasks:v1", jpiBackgroundTasksPayload([
    { kind: "task", id: "abc", status: "running" },
  ]));
  assert.deepEqual(applied, [[{ id: namespaced("abc"), isAgent: false }]]);

  // A stale initial response arriving after the level channel must not overwrite it.
  events.emit("jpi-background:response:v1", jpiBackgroundStatusResponse({ request_id: "req-1" }, [
    { kind: "task", id: "zzz", status: "running" },
  ]));
  assert.equal(applied.length, 1);

  events.emit("jpi-background:tasks:v1", jpiBackgroundTasksPayload([
    { kind: "task", id: "abc", status: "running" },
    { kind: "monitor", id: "mon", status: "running" },
  ]));
  assert.deepEqual(applied.at(-1), [
    { id: namespaced("abc"), isAgent: false },
    { id: namespaced("mon"), isAgent: false },
  ]);

  events.emit("jpi-background:terminal:v1", jpiBackgroundTerminalPayload({ kind: "task", id: "abc", status: "completed" }));
  assert.deepEqual(applied.at(-1), [{ id: namespaced("mon"), isAgent: false }]);

  const beforeRepeat = applied.length;
  events.emit("jpi-background:terminal:v1", jpiBackgroundTerminalPayload({ kind: "task", id: "abc", status: "completed" }));
  assert.equal(applied.length, beforeRepeat);

  monitor.dispose();
  assert.equal(events.unsubscribed, 3);
});

test("an initial status response applies when no level broadcast has arrived yet", () => {
  const events = new PlanterEventBus();
  const applied: Array<Array<{ id: string; isAgent: boolean }>> = [];
  const monitor = new JpiBackgroundTaskMonitor(events, () => "req-1", (tasks) => applied.push([...tasks.values()]));
  monitor.start();

  events.emit("jpi-background:response:v1", jpiBackgroundStatusResponse({ request_id: "req-1" }, [
    { kind: "task", id: "abc", status: "running" },
  ]));
  assert.deepEqual(applied, [[{ id: namespaced("abc"), isAgent: false }]]);

  monitor.dispose();
});

test("published state merges both providers by namespaced id and each can sustain 'working' alone", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = planterHarness(directory);
  await harness.extension.onSessionStart({}, harness.context);
  const path = harness.extension.recordPath()!;

  const legacyRequest = backgroundRequests(harness.events)[0];
  const jpiRequest = jpiBackgroundRequests(harness.events)[0];

  // Same raw id on both providers: if the merge ever collided on id, this
  // legacy agent-task would be clobbered by the jpi-background entry below.
  harness.events.emit("pi-background-tasks:response:v1", backgroundResponse(legacyRequest, [
    { id: "same", status: "running", isAgent: true },
  ]));
  await harness.extension.flush();
  assert.deepEqual(
    (({ state, agents }) => ({ state, agents }))(await readRecord(path)),
    { state: "working", agents: 1 },
  );

  harness.events.emit("jpi-background:response:v1", jpiBackgroundStatusResponse(jpiRequest, [
    { kind: "task", id: "same", status: "running" },
  ]));
  await harness.extension.flush();
  assert.deepEqual(
    (({ state, agents }) => ({ state, agents }))(await readRecord(path)),
    { state: "working", agents: 1 },
  );

  const poll = harness.scheduler.active("interval", 1_000)[0];
  harness.scheduler.fire(poll);
  const refresh = backgroundRequests(harness.events).at(-1)!;
  harness.events.emit("pi-background-tasks:response:v1", backgroundResponse(refresh, []));
  await harness.extension.flush();
  assert.deepEqual(
    (({ state, agents }) => ({ state, agents }))(await readRecord(path)),
    { state: "working", agents: 0 },
  );

  harness.events.emit("jpi-background:tasks:v1", jpiBackgroundTasksPayload([]));
  await harness.extension.flush();
  assert.equal((await readRecord(path)).state, "waiting");

  await harness.extension.onSessionShutdown({ reason: "quit" }, harness.context);
});

test("state is unaffected when the jpi-background provider is absent", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = planterHarness(directory);
  await harness.extension.onSessionStart({}, harness.context);
  const path = harness.extension.recordPath()!;

  const legacyRequest = backgroundRequests(harness.events)[0];
  harness.events.emit("pi-background-tasks:response:v1", backgroundResponse(legacyRequest, [
    { id: "job", status: "running", isAgent: false },
  ]));
  await harness.extension.flush();
  assert.equal((await readRecord(path)).state, "working");

  const poll = harness.scheduler.active("interval", 1_000)[0];
  harness.scheduler.fire(poll);
  const refresh = backgroundRequests(harness.events).at(-1)!;
  harness.events.emit("pi-background-tasks:response:v1", backgroundResponse(refresh, []));
  await harness.extension.flush();
  assert.equal((await readRecord(path)).state, "waiting");

  await harness.extension.onSessionShutdown({ reason: "quit" }, harness.context);
});
