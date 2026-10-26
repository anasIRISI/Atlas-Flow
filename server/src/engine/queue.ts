export type Priority = 'high' | 'normal';

interface Job {
  id: string;
  run: () => Promise<void>;
  cancel: () => void;
}

/** In-process FIFO queue with a concurrency limit. Manual runs ("high") go before triggered runs. */
export class ExecutionQueue {
  private readonly high: Job[] = [];
  private readonly normal: Job[] = [];
  private activeCount = 0;

  constructor(private concurrency: number) {}

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n));
    this.next();
  }

  get active(): number {
    return this.activeCount;
  }

  get waiting(): number {
    return this.high.length + this.normal.length;
  }

  add(id: string, run: () => Promise<void>, cancel: () => void, priority: Priority = 'normal'): void {
    (priority === 'high' ? this.high : this.normal).push({ id, run, cancel });
    this.next();
  }

  /** Removes a job that has not started yet. Returns false if it is already running (or unknown). */
  remove(id: string): boolean {
    for (const list of [this.high, this.normal]) {
      const index = list.findIndex((j) => j.id === id);
      if (index >= 0) {
        const [job] = list.splice(index, 1);
        job!.cancel();
        return true;
      }
    }
    return false;
  }

  clear(): void {
    for (const job of [...this.high.splice(0), ...this.normal.splice(0)]) job.cancel();
  }

  private next(): void {
    while (this.activeCount < this.concurrency) {
      const job = this.high.shift() ?? this.normal.shift();
      if (!job) return;
      this.activeCount++;
      void job.run().finally(() => {
        this.activeCount--;
        this.next();
      });
    }
  }
}
