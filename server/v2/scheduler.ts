export type SchedulerChannel = 'realtime' | 'model' | 'background';
export type SchedulerLimits = { modelGlobal: number; modelPerSession: number; background: number };
type Task<T> = { sessionId: string; run: () => Promise<T> | T; resolve: (value: T) => void; reject: (error: unknown) => void };

export type SchedulerSnapshot = {
  model: { running: number; queued: number };
  background: { running: number; queued: number; paused: boolean };
};

export class BoundedScheduler {
  private readonly limits: SchedulerLimits;
  private readonly queues: Record<'model' | 'background', Task<unknown>[]> = { model: [], background: [] };
  private readonly modelBySession = new Map<string, number>();
  private modelRunning = 0;
  private backgroundRunning = 0;
  private backgroundPaused = false;

  constructor(limits: SchedulerLimits) {
    this.limits = {
      modelGlobal: Math.max(1, Math.floor(limits.modelGlobal)),
      modelPerSession: Math.max(1, Math.floor(limits.modelPerSession)),
      background: Math.max(1, Math.floor(limits.background)),
    };
  }

  run<T>(channel: SchedulerChannel, sessionId: string, task: () => Promise<T> | T): Promise<T> {
    if (channel === 'realtime') {
      try { return Promise.resolve(task()); } catch (error) { return Promise.reject(error); }
    }
    return new Promise<T>((resolve, reject) => {
      this.queues[channel].push({ sessionId, run: task, resolve: resolve as (value: unknown) => void, reject });
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
      const nextIndex = channel === 'model' ? queue.findIndex((task) => (this.modelBySession.get(task.sessionId) ?? 0) < this.limits.modelPerSession) : 0;
      if (nextIndex < 0) return;
      if (channel === 'model' && this.modelRunning >= this.limits.modelGlobal) return;
      if (channel === 'background' && this.backgroundRunning >= this.limits.background) return;
      const [task] = queue.splice(nextIndex, 1);
      if (channel === 'model') {
        this.modelRunning += 1;
        this.modelBySession.set(task.sessionId, (this.modelBySession.get(task.sessionId) ?? 0) + 1);
      } else this.backgroundRunning += 1;
      Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
        if (channel === 'model') {
          this.modelRunning -= 1;
          const count = (this.modelBySession.get(task.sessionId) ?? 1) - 1;
          if (count <= 0) this.modelBySession.delete(task.sessionId); else this.modelBySession.set(task.sessionId, count);
        } else this.backgroundRunning -= 1;
        this.drain(channel);
      });
    }
  }
}
