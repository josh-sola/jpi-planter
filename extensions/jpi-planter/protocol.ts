export const ASK_USER_BLOCKED_CHANNEL = "rpiv:ask-user:blocked";
export const SUBAGENT_STARTED_CHANNEL = "subagents:started";
export const SUBAGENT_COMPLETED_CHANNEL = "subagents:completed";
export const SUBAGENT_FAILED_CHANNEL = "subagents:failed";

export const BACKGROUND_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
export const BACKGROUND_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
export const BACKGROUND_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
export const BACKGROUND_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
export const BACKGROUND_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
export const BACKGROUND_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";
export const BACKGROUND_POLL_INTERVAL_MS = 1_000;
export const BACKGROUND_RESPONSE_TIMEOUT_MS = 3_000;
export const MAX_PENDING_BACKGROUND_REQUESTS = 4;
export const SUBAGENT_STALE_MS = 30 * 60 * 1_000;

export const JPI_BACKGROUND_REQUEST_CHANNEL = "jpi-background:request:v1";
export const JPI_BACKGROUND_RESPONSE_CHANNEL = "jpi-background:response:v1";
export const JPI_BACKGROUND_TERMINAL_CHANNEL = "jpi-background:terminal:v1";
export const JPI_BACKGROUND_TASKS_CHANNEL = "jpi-background:tasks:v1";
export const JPI_BACKGROUND_REQUEST_SCHEMA = "jpi-background.request.v1";
export const JPI_BACKGROUND_RESPONSE_SCHEMA = "jpi-background.response.v1";
export const JPI_BACKGROUND_TERMINAL_SCHEMA = "jpi-background.terminal.v1";
export const JPI_BACKGROUND_TASKS_SCHEMA = "jpi-background.tasks.v1";
/** Keeps jpi-background ids out of the pi-background-tasks id space wherever the two providers' running sets are merged. */
export const JPI_BACKGROUND_ID_PREFIX = "jpi-background:";

export type EventBus = {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
};

export type Scheduler = {
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(timer: unknown): void;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type RunningBackgroundTask = {
  id: string;
  isAgent: boolean;
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalEventId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const id = data.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function askUserBlocked(data: unknown): boolean | undefined {
  if (!isRecord(data) || typeof data.active !== "boolean") return undefined;
  return data.active;
}

function parseBackgroundTask(
  data: unknown,
): { id: string; status: string; isAgent: boolean } | undefined {
  if (!isRecord(data)) return undefined;
  const { id, status, isAgent } = data;
  if (typeof id !== "string" || id.length === 0 || typeof isAgent !== "boolean") {
    return undefined;
  }
  if (
    status !== "running" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "killed"
  ) {
    return undefined;
  }
  return { id, status, isAgent };
}

export function runningBackgroundTasks(
  data: unknown,
  requestId: string,
): Map<string, RunningBackgroundTask> | undefined {
  if (
    !isRecord(data) ||
    data.schema_version !== BACKGROUND_RESPONSE_SCHEMA ||
    data.request_id !== requestId ||
    data.operation !== "status" ||
    data.ok !== true ||
    !isRecord(data.result) ||
    !Array.isArray(data.result.tasks)
  )
    return undefined;

  const parsed = data.result.tasks.map(parseBackgroundTask);
  if (parsed.some((task) => task === undefined)) return undefined;

  const active = new Map<string, RunningBackgroundTask>();
  for (const task of parsed as Array<{ id: string; status: string; isAgent: boolean }>) {
    if (task.status !== "running") continue;
    const previous = active.get(task.id);
    active.set(task.id, { id: task.id, isAgent: task.isAgent || previous?.isAgent === true });
  }
  return active;
}

export function isBackgroundTerminal(data: unknown): boolean {
  if (!isRecord(data) || data.schema_version !== BACKGROUND_TERMINAL_SCHEMA) return false;
  const task = parseBackgroundTask(data.task);
  return task !== undefined && task.status !== "running";
}

const JPI_BACKGROUND_TASK_STATUSES = new Set(["running", "completed", "failed", "killed"]);
const JPI_BACKGROUND_MONITOR_STATUSES = new Set([
  "running",
  "exited",
  "timeout",
  "cancelled",
  "failed",
]);

function parseJpiBackgroundSnapshot(data: unknown): { id: string; running: boolean } | undefined {
  if (!isRecord(data)) return undefined;
  const { kind, id, status } = data;
  if (typeof id !== "string" || id.length === 0 || typeof status !== "string") return undefined;
  if (kind === "task" && JPI_BACKGROUND_TASK_STATUSES.has(status))
    return { id, running: status === "running" };
  if (kind === "monitor" && JPI_BACKGROUND_MONITOR_STATUSES.has(status))
    return { id, running: status === "running" };
  return undefined;
}

function jpiBackgroundNamespacedId(id: string): string {
  return `${JPI_BACKGROUND_ID_PREFIX}${id}`;
}

// A monitor snapshot maps onto the same RunningBackgroundTask shape as a task
// snapshot: jpi-background has no isAgent concept, so it is always false here.
function jpiBackgroundActiveSet(
  snapshots: unknown[],
): Map<string, RunningBackgroundTask> | undefined {
  const parsed = snapshots.map(parseJpiBackgroundSnapshot);
  if (parsed.some((task) => task === undefined)) return undefined;

  const active = new Map<string, RunningBackgroundTask>();
  for (const task of parsed as Array<{ id: string; running: boolean }>) {
    if (!task.running) continue;
    const id = jpiBackgroundNamespacedId(task.id);
    active.set(id, { id, isAgent: false });
  }
  return active;
}

export function jpiBackgroundRunningTasks(
  data: unknown,
  requestId: string,
): Map<string, RunningBackgroundTask> | undefined {
  if (
    !isRecord(data) ||
    data.schema !== JPI_BACKGROUND_RESPONSE_SCHEMA ||
    data.request_id !== requestId ||
    data.operation !== "status" ||
    data.ok !== true ||
    !isRecord(data.result) ||
    !Array.isArray(data.result.tasks)
  )
    return undefined;

  return jpiBackgroundActiveSet(data.result.tasks);
}

export function jpiBackgroundTasksLevel(
  data: unknown,
): Map<string, RunningBackgroundTask> | undefined {
  if (
    !isRecord(data) ||
    data.schema !== JPI_BACKGROUND_TASKS_SCHEMA ||
    !Array.isArray(data.tasks)
  ) {
    return undefined;
  }
  return jpiBackgroundActiveSet(data.tasks);
}

export function jpiBackgroundTerminalId(data: unknown): string | undefined {
  if (!isRecord(data) || data.schema !== JPI_BACKGROUND_TERMINAL_SCHEMA) return undefined;
  const task = parseJpiBackgroundSnapshot(data.task);
  return task && !task.running ? jpiBackgroundNamespacedId(task.id) : undefined;
}
