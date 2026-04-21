export interface TimedJob {
  job_id: string;
  created_at: string;
  updated_at: string;
}

export const nowIso = (): string => new Date().toISOString();

export const createJobId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export class InMemoryJobManager<T extends TimedJob> {
  private readonly jobs = new Map<string, T>();

  constructor(private readonly ttlMs: number) {}

  set(job: T): void {
    this.jobs.set(job.job_id, job);
  }

  get(jobId: string): T | undefined {
    return this.jobs.get(jobId);
  }

  list(): T[] {
    return [...this.jobs.values()];
  }

  cleanupExpired(): void {
    const deadline = Date.now() - this.ttlMs;
    for (const [jobId, job] of this.jobs.entries()) {
      if (new Date(job.updated_at).getTime() < deadline) {
        this.jobs.delete(jobId);
      }
    }
  }
}
