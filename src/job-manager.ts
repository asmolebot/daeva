import { HttpPodAdapter, type PodAdapter } from './adapters.js';
import { NotFoundError } from './errors.js';
import { PodController } from './pod-controller.js';
import { PodRegistry } from './registry.js';
import { SchedulerRouter } from './router.js';
import type { JobRecord, JobRequest } from './types.js';
import { nowIso, randomId } from './utils.js';

export interface JobManagerOptions {
  adapter?: PodAdapter;
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private readonly adapter: PodAdapter;
  private processing = false;

  constructor(
    private readonly registry: PodRegistry,
    private readonly podController: PodController,
    private readonly router: SchedulerRouter,
    options: JobManagerOptions = {}
  ) {
    this.adapter = options.adapter ?? new HttpPodAdapter();
  }

  enqueue(request: JobRequest): JobRecord {
    const now = nowIso();
    const job: JobRecord = {
      id: randomId('job'),
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      request
    };

    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    void this.processNext();
    return job;
  }

  listJobs(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listRecentJobs(limit = 10): JobRecord[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getJob(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) {
      throw new NotFoundError(`Job not found: ${id}`);
    }

    return job;
  }

  getResult(id: string): unknown {
    const job = this.getJob(id);
    if (job.status !== 'completed') {
      return null;
    }

    return job.result ?? null;
  }

  async waitForIdle(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async processNext(): Promise<void> {
    if (this.processing) {
      return;
    }

    const nextJobId = this.queue.shift();
    if (!nextJobId) {
      return;
    }

    this.processing = true;
    const job = this.getJob(nextJobId);

    try {
      const pod = await this.router.route(job.request);
      const startedAt = nowIso();
      job.status = 'running';
      job.startedAt = startedAt;
      job.updatedAt = startedAt;
      job.selectedPodId = pod.id;

      this.podController.markJobStarted(pod.id, job.id);
      const result = await this.adapter.execute(pod, job.request);
      const completedAt = nowIso();
      job.status = 'completed';
      job.completedAt = completedAt;
      job.updatedAt = completedAt;
      job.result = result;
      this.podController.markJobFinished(pod.id);
    } catch (error) {
      const failedAt = nowIso();
      job.status = 'failed';
      job.updatedAt = failedAt;
      job.completedAt = failedAt;
      job.error = error instanceof Error ? error.message : 'Unknown job failure';
      if (job.selectedPodId) {
        this.podController.markJobFinished(job.selectedPodId);
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        void this.processNext();
      }
    }
  }

  registrySnapshot() {
    return this.podController.snapshot(this.registry.list());
  }
}
