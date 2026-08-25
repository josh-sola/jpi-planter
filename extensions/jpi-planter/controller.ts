import { BackgroundTaskMonitor, JpiBackgroundTaskMonitor } from "./background.ts";
import { resolvePlanterLabel, type ExecCommand } from "./helpers.ts";
import {
  ASK_USER_BLOCKED_CHANNEL,
  SUBAGENT_COMPLETED_CHANNEL,
  SUBAGENT_FAILED_CHANNEL,
  SUBAGENT_STARTED_CHANNEL,
  SUBAGENT_STALE_MS,
  askUserBlocked,
  optionalEventId,
  type EventBus,
  type RunningBackgroundTask,
  type Scheduler,
} from "./protocol.ts";
import { PlanterSessionState, type StateEnvironment } from "./state.ts";
import { PlanterStore } from "./store.ts";

export type PlanterContext = {
  mode: string;
  cwd: string;
  sessionManager: { getSessionId(): string };
};

export type ControllerDependencies = {
  exec: ExecCommand;
  events: EventBus;
  getSessionName(): string | undefined;
  scheduler: Scheduler;
  requestId(): string;
  generation: number;
  environment: StateEnvironment;
  pid: number;
  now(): number;
  stateDirectory: string;
  tempId?: () => string;
};

export class PlanterController {
  readonly sessionId: string;
  private readonly store: PlanterStore;
  private readonly labelAbort = new AbortController();
  private state?: PlanterSessionState;
  private background?: BackgroundTaskMonitor;
  private jpiBackground?: JpiBackgroundTaskMonitor;
  private legacyBackgroundTasks = new Map<string, RunningBackgroundTask>();
  private jpiBackgroundTasks = new Map<string, RunningBackgroundTask>();
  private unsubscribers: Array<() => void> = [];
  private subagentTimers = new Map<string, unknown>();
  private labelRevision = 0;
  private disposed = false;
  private readonly dependencies: ControllerDependencies;
  private readonly context: PlanterContext;

  constructor(dependencies: ControllerDependencies, context: PlanterContext) {
    this.dependencies = dependencies;
    this.context = context;
    this.sessionId = context.sessionManager.getSessionId();
    this.store = new PlanterStore(
      dependencies.stateDirectory,
      this.sessionId,
      dependencies.pid,
      dependencies.tempId,
    );
  }

  async start(): Promise<void> {
    const [existing, label] = await Promise.all([this.store.read(), this.loadLabel()]);
    if (this.disposed) return;
    this.state = new PlanterSessionState({
      sessionId: this.sessionId,
      pid: this.dependencies.pid,
      cwd: this.context.cwd,
      label,
      environment: this.dependencies.environment,
      now: this.dependencies.now,
      existing,
    });
    await this.persist();
    if (this.disposed) return;

    this.unsubscribers = [
      this.dependencies.events.on(SUBAGENT_STARTED_CHANNEL, (data) => {
        const id = optionalEventId(data);
        if (id) this.startSubagent(id);
      }),
      this.dependencies.events.on(SUBAGENT_COMPLETED_CHANNEL, (data) => {
        const id = optionalEventId(data);
        if (id) this.finishSubagent(id);
      }),
      this.dependencies.events.on(SUBAGENT_FAILED_CHANNEL, (data) => {
        const id = optionalEventId(data);
        if (id) this.finishSubagent(id);
      }),
      this.dependencies.events.on(ASK_USER_BLOCKED_CHANNEL, (data) => {
        const active = askUserBlocked(data);
        if (active !== undefined) void this.update(this.state?.setAttention(active) === true);
      }),
    ];
    this.background = new BackgroundTaskMonitor(
      this.dependencies.events,
      this.dependencies.scheduler,
      this.dependencies.generation,
      this.dependencies.requestId,
      (tasks) => this.mergeBackground("legacy", tasks),
    );
    this.background.start();

    this.jpiBackground = new JpiBackgroundTaskMonitor(
      this.dependencies.events,
      this.dependencies.requestId,
      (tasks) => this.mergeBackground("jpi-background", tasks),
    );
    this.jpiBackground.start();
  }

  setMain(active: boolean): Promise<void> {
    return this.update(this.state?.setMain(active) === true);
  }

  async refreshLabel(): Promise<void> {
    if (this.disposed || !this.state) return;
    const revision = ++this.labelRevision;
    const label = await this.loadLabel();
    if (this.disposed || revision !== this.labelRevision) return;
    await this.update(this.state.setLabel(label));
  }

  async shutdown(preserve: boolean): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.labelRevision += 1;
    this.labelAbort.abort();
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch {}
    }
    this.unsubscribers = [];
    this.background?.dispose();
    this.background = undefined;
    this.jpiBackground?.dispose();
    this.jpiBackground = undefined;
    for (const timer of this.subagentTimers.values()) {
      this.dependencies.scheduler.clearTimeout(timer);
    }
    this.subagentTimers.clear();
    await this.store.flush();
    if (!preserve) await this.store.remove();
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  recordPath(): string {
    return this.store.path;
  }

  private loadLabel(): Promise<string> {
    return resolvePlanterLabel({
      environment: this.dependencies.environment,
      getSessionName: this.dependencies.getSessionName,
      exec: this.dependencies.exec,
      stateDirectory: this.dependencies.stateDirectory,
      cwd: this.context.cwd,
      signal: this.labelAbort.signal,
    });
  }

  private startSubagent(id: string): void {
    if (this.disposed || !this.state) return;
    const previous = this.subagentTimers.get(id);
    if (previous !== undefined) this.dependencies.scheduler.clearTimeout(previous);
    let timer: unknown;
    timer = this.dependencies.scheduler.setTimeout(() => {
      if (this.disposed || this.subagentTimers.get(id) !== timer) return;
      this.subagentTimers.delete(id);
      void this.update(this.state?.finishSubagent(id) === true);
    }, SUBAGENT_STALE_MS);
    this.subagentTimers.set(id, timer);
    void this.update(this.state.startSubagent(id));
  }

  private finishSubagent(id: string): void {
    if (this.disposed || !this.state) return;
    const timer = this.subagentTimers.get(id);
    if (timer !== undefined) this.dependencies.scheduler.clearTimeout(timer);
    this.subagentTimers.delete(id);
    void this.update(this.state.finishSubagent(id));
  }

  private mergeBackground(
    provider: "legacy" | "jpi-background",
    tasks: Map<string, RunningBackgroundTask>,
  ): void {
    if (provider === "legacy") this.legacyBackgroundTasks = tasks;
    else this.jpiBackgroundTasks = tasks;
    // jpi-background ids are namespaced (see JPI_BACKGROUND_ID_PREFIX), so this union can't collide.
    this.setBackground(new Map([...this.legacyBackgroundTasks, ...this.jpiBackgroundTasks]));
  }

  private setBackground(tasks: Map<string, RunningBackgroundTask>): void {
    if (this.disposed || !this.state) return;
    void this.update(this.state.setBackground(tasks));
  }

  private update(changed: boolean): Promise<void> {
    return changed ? this.persist() : Promise.resolve();
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    await this.store.write(this.state.record());
  }
}
