export type SchedulerChannel = 'realtime' | 'model' | 'background';
export type ModelPriority = 'normal' | 'low';
export type SchedulerLimits = { modelGlobal: number; modelPerSession: number; background: number };
type Task<T> = { sessionId: string; priority: ModelPriority; run: () => Promise<T> | T; resolve: (value: T) => void; reject: (error: unknown) => void };

export type SchedulerSnapshot = {
  model: { running: number; queued: number };
  background: { running: number; queued: number; paused: boolean };
};

export class BoundedScheduler {
  private readonly limits: SchedulerLimits;
  private readonly queues: Record<'model' | 'background', Task<unknown>[]> = { model: [], background: [] };
  private readonly modelBySession = new Map<string, number>();
  private modelRunning = 0;
  private lowPriorityModelRunning = 0;
  private backgroundRunning = 0;
  private backgroundPaused = false;

  constructor(limits: SchedulerLimits) {
    this.limits = {
      modelGlobal: Math.max(1, Math.floor(limits.modelGlobal)),
      modelPerSession: Math.max(1, Math.floor(limits.modelPerSession)),
      background: Math.max(1, Math.floor(limits.background)),
    };
  }

  run<T>(channel: SchedulerChannel, sessionId: string, task: () => Promise<T> | T, options: { priority?: ModelPriority } = {}): Promise<T> {
    if (channel === 'realtime') {
      try { return Promise.resolve(task()); } catch (error) { return Promise.reject(error); }
    }
    return new Promise<T>((resolve, reject) => {
      this.queues[channel].push({ sessionId, priority: channel === 'model' ? options.priority ?? 'normal' : 'normal', run: task, resolve: resolve as (value: unknown) => void, reject });
      this.drain(channel);
    });
  }

  pauseBackground(): void {
    this.backgroundPaused = true;
  }

  resumeBackground(): void {
    this.backgroundPaused = false;
    this.drain('background');
  }

  snapshot(): SchedulerSnapshot {
    return {
      model: { running: this.modelRunning, queued: this.queues.model.length },
      background: { running: this.backgroundRunning, queued: this.queues.background.length, paused: this.backgroundPaused },
    };
  }

  private drain(channel: 'model' | 'background'): void {
    if (channel === 'background' && this.backgroundPaused) return;
    const queue = this.queues[channel];
    while (queue.length > 0) {
      const nextIndex = channel === 'model' ? this.nextModelTaskIndex(queue) : 0;
      if (nextIndex < 0) return;
      if (channel === 'model' && this.modelRunning >= this.limits.modelGlobal) return;
      if (channel === 'background' && this.backgroundRunning >= this.limits.background) return;
      const [task] = queue.splice(nextIndex, 1);
      if (channel === 'model') {
        this.modelRunning += 1;
        if (task.priority === 'low') this.lowPriorityModelRunning += 1;
        this.modelBySession.set(task.sessionId, (this.modelBySession.get(task.sessionId) ?? 0) + 1);
      } else this.backgroundRunning += 1;
      Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
        if (channel === 'model') {
          this.modelRunning -= 1;
          if (task.priority === 'low') this.lowPriorityModelRunning -= 1;
          const count = (this.modelBySession.get(task.sessionId) ?? 1) - 1;
          if (count <= 0) this.modelBySession.delete(task.sessionId); else this.modelBySession.set(task.sessionId, count);
        } else this.backgroundRunning -= 1;
        this.drain(channel);
      });
    }
  }

  private nextModelTaskIndex(queue: Task<unknown>[]): number {
    const runnable = (task: Task<unknown>) => (this.modelBySession.get(task.sessionId) ?? 0) < this.limits.modelPerSession;
    const normal = queue.findIndex((task) => task.priority === 'normal' && runnable(task));
    if (normal >= 0) return normal;
    if (this.lowPriorityModelRunning > 0 || this.modelRunning >= Math.max(1, this.limits.modelGlobal - 1)) return -1;
    return queue.findIndex((task) => task.priority === 'low' && runnable(task));
  }
}
