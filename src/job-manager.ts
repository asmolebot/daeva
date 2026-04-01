import { HttpPodAdapter, type PodAdapter } from './adapters.js';
import { AppError, ConflictError, NotFoundError } from './errors.js';
import { createFailedResult, inferCapabilityForJobType, validateJobRequest } from './job-contracts.js';
import { InMemoryJobStore, type JobStore } from './job-store.js';
import { PodController } from './pod-controller.js';
import { PodRegistry } from './registry.js';
import { SchedulerRouter } from './router.js';
import type { JobFailureInfo, JobPriority, JobRecord, JobRequest, PodManifest } from './types.js';
import { nowIso, randomId } from './utils.js';

export interface JobManagerOptions {
  adapter?: PodAdapter;
  store?: JobStore;
}

/** Numeric priority values — lower number = higher priority. */
const PRIORITY_VALUES: Record<JobPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3
};

interface QueueEntry {
  id: string;
  priority: number;
}

const serializeJobFailure = (error: unknown): JobFailureInfo => {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      retriable: error.retriable ?? false
    };
  }

  if (error instanceof Error) {
    return {
      code: 'INTERNAL_ERROR',
      message: error.message,
      retriable: false
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'Unknown job failure',
    retriable: false
  };
};

export class JobManager {
  private readonly store: JobStore;
  private readonly queue: QueueEntry[] = [];
  private readonly adapter: PodAdapter;
  private scheduling = false;
  private readonly runningJobs = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly registry: PodRegistry,
    private readonly podController: PodController,
    private readonly router: SchedulerRouter,
    options: JobManagerOptions = {}
  ) {
    this.adapter = options.adapter ?? new HttpPodAdapter();
    this.store = options.store ?? new InMemoryJobStore();
  }

  enqueue(request: JobRequest): JobRecord {
    const capability = validateJobRequest(request);
    const priority: JobPriority = request.priority ?? 'normal';
    const now = nowIso();
    const job: JobRecord = {
      id: randomId('job'),
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      priority,
      request,
      resolvedCapability: capability
    };

    this.store.save(job);

    // Insert into queue in priority order (lower value = higher priority, FIFO within same level)
    const pVal = PRIORITY_VALUES[priority];
    const insertIdx = this.queue.findIndex((entry) => entry.priority > pVal);
    const queueEntry: QueueEntry = { id: job.id, priority: pVal };
    if (insertIdx === -1) {
      this.queue.push(queueEntry);
    } else {
      this.queue.splice(insertIdx, 0, queueEntry);
    }

    void this.processNext();
    return job;
  }

  listJobs(): JobRecord[] {
    return this.store.list();
  }

  listRecentJobs(limit = 10): JobRecord[] {
    return this.store.listRecent(limit);
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  isProcessing(): boolean {
    return this.runningJobs.size > 0;
  }

  /** Get the 1-based queue position of a job, or null if not queued. */
  getQueuePosition(jobId: string): number | null {
    const idx = this.queue.findIndex((entry) => entry.id === jobId);
    return idx === -1 ? null : idx + 1;
  }

  getJob(id: string): JobRecord {
    const job = this.store.get(id);
    if (!job) {
      throw new NotFoundError(`Job not found: ${id}`, { details: { jobId: id } });
    }

    return job;
  }

  getResult(id: string) {
    const job = this.getJob(id);
    if (job.status !== 'completed' && job.status !== 'failed') {
      return null;
    }

    return job.result ?? null;
  }

  cancelJob(id: string): { ok: boolean; reason?: string } {
    const job = this.getJob(id); // throws NotFoundError if missing

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      throw new ConflictError(`Job ${id} is already in terminal state: ${job.status}`, {
        details: { jobId: id, status: job.status }
      });
    }

    if (job.status === 'queued') {
      const queueIdx = this.queue.findIndex((entry) => entry.id === id);
      if (queueIdx !== -1) {
        this.queue.splice(queueIdx, 1);
      }
      const now = nowIso();
      job.status = 'cancelled';
      job.updatedAt = now;
      job.completedAt = now;
      job.error = { code: 'JOB_CANCELLED', message: 'Job cancelled by user', retriable: false };
      this.store.save(job);
      return { ok: true };
    }

    if (job.status === 'running') {
      const ac = this.abortControllers.get(id);
      if (ac) {
        ac.abort();
      }
      const now = nowIso();
      job.status = 'cancelled';
      job.updatedAt = now;
      job.completedAt = now;
      job.error = { code: 'JOB_CANCELLED', message: 'Job cancelled by user', retriable: false };
      this.store.save(job);
      if (job.selectedPodId) {
        this.podController.markJobFinished(job.selectedPodId, id);
      }
      return { ok: true };
    }

    return { ok: false, reason: `Unexpected job status: ${job.status}` };
  }

  async waitForIdle(): Promise<void> {
    while (this.runningJobs.size > 0 || this.queue.length > 0 || this.scheduling) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async processNext(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;

    try {
      while (this.queue.length > 0) {
        const entry = this.queue[0];
        const job = this.store.get(entry.id);

        // Skip cancelled/missing jobs
        if (!job || job.status === 'cancelled') {
          this.queue.shift();
          continue;
        }

        let pod: PodManifest;
        try {
          pod = this.router.selectPod(job.request);
        } catch (error) {
          this.queue.shift();
          const failedAt = nowIso();
          job.status = 'failed';
          job.updatedAt = failedAt;
          job.completedAt = failedAt;
          job.error = serializeJobFailure(error);
          job.result = createFailedResult(undefined, job.request, job.resolvedCapability, error);
          this.store.save(job);
          continue;
        }

        // Check per-pod concurrency limit
        const maxConcurrent = pod.maxConcurrentJobs ?? 1;
        if (this.podController.getActiveJobCount(pod.id) >= maxConcurrent) {
          break; // pod at capacity, wait for a slot
        }

        this.queue.shift();

        // Ensure pod is started (handles exclusivity groups)
        try {
          await this.podController.ensureExclusive(pod, this.registry.list());
        } catch (error) {
          const failedAt = nowIso();
          job.status = 'failed';
          job.updatedAt = failedAt;
          job.completedAt = failedAt;
          job.error = serializeJobFailure(error);
          job.result = createFailedResult(
            this.registry.get(pod.id),
            job.request,
            job.resolvedCapability,
            error
          );
          this.store.save(job);
          continue;
        }

        // Mark as running
        const ac = new AbortController();
        this.abortControllers.set(job.id, ac);
        const startedAt = nowIso();
        job.status = 'running';
        job.startedAt = startedAt;
        job.updatedAt = startedAt;
        job.selectedPodId = pod.id;
        job.resolvedCapability =
          job.resolvedCapability ?? job.request.capability ?? inferCapabilityForJobType(job.request.type);
        this.store.save(job);
        this.podController.markJobStarted(pod.id, job.id);
        this.runningJobs.add(job.id);

        // Execute in background (don't await — allows concurrent jobs)
        void this.executeJob(job, pod);
      }
    } finally {
      this.scheduling = false;
    }
  }

  private async executeJob(job: JobRecord, pod: PodManifest): Promise<void> {
    try {
      const result = await this.adapter.execute(pod, job.request);
      // Skip state mutation if job was cancelled while running
      if (job.status !== 'cancelled') {
        const completedAt = nowIso();
        job.status = result.status === 'failed' ? 'failed' : 'completed';
        job.completedAt = completedAt;
        job.updatedAt = completedAt;
        job.result = result;
        job.error = result.output.error
          ? {
              code: result.output.error.code,
              message: result.output.error.message,
              details: result.output.error.details,
              retriable: result.output.error.retriable
            }
          : undefined;
        this.store.save(job);
        this.podController.markJobFinished(pod.id, job.id);
      }
    } catch (error) {
      // Skip state mutation if job was cancelled while running
      if (job.status !== 'cancelled') {
        const failedAt = nowIso();
        job.status = 'failed';
        job.updatedAt = failedAt;
        job.completedAt = failedAt;
        job.error = serializeJobFailure(error);
        job.result = createFailedResult(
          job.selectedPodId ? this.registry.get(job.selectedPodId) : undefined,
          job.request,
          job.resolvedCapability,
          error
        );
        this.store.save(job);
        if (job.selectedPodId) {
          this.podController.markJobFinished(job.selectedPodId, job.id);
        }
      }
    } finally {
      this.abortControllers.delete(job.id);
      this.runningJobs.delete(job.id);
      // Re-trigger scheduling when a slot frees up
      if (this.queue.length > 0) {
        void this.processNext();
      }
    }
  }

  registrySnapshot() {
    return this.podController.snapshot(this.registry.list());
  }
}
