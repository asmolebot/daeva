import { SchedulingError } from './errors.js';
import { inferCapabilityForJobType } from './job-contracts.js';
import { PodController } from './pod-controller.js';
import { PodRegistry } from './registry.js';
import type { JobRequest, PodManifest } from './types.js';

export class SchedulerRouter {
  constructor(
    private readonly registry: PodRegistry,
    private readonly podController: PodController
  ) {}

  async route(request: JobRequest): Promise<PodManifest> {
    const pod = this.selectPod(request);
    await this.podController.ensureExclusive(pod, this.registry.list());
    return pod;
  }

  selectPod(request: JobRequest): PodManifest {
    if (request.preferredPodId) {
      const preferred = this.registry.get(request.preferredPodId);
      if (!preferred) {
        throw new SchedulingError(`Preferred pod not found: ${request.preferredPodId}`, {
          details: { preferredPodId: request.preferredPodId }
        });
      }

      return preferred;
    }

    const capability = request.capability ?? inferCapabilityForJobType(request.type);
    const candidates = this.registry.findByCapability(capability);

    if (candidates.length === 0) {
      throw new SchedulingError(`No pod registered for capability: ${capability}`, {
        details: { capability, jobType: request.type }
      });
    }

    // Sort by cost weight (lower = cheaper/preferred)
    const sorted = [...candidates].sort(
      (a, b) => (a.costWeight ?? 1) - (b.costWeight ?? 1)
    );

    // Prefer a running pod with available capacity
    const runningWithCapacity = sorted.find((candidate) => {
      if (this.podController.getStatus(candidate.id) !== 'running') return false;
      const active = this.podController.getActiveJobCount(candidate.id);
      const max = candidate.maxConcurrentJobs ?? 1;
      return active < max;
    });
    if (runningWithCapacity) return runningWithCapacity;

    // Fall back to any pod not at capacity (may need startup)
    const withCapacity = sorted.find((candidate) => {
      const active = this.podController.getActiveJobCount(candidate.id);
      const max = candidate.maxConcurrentJobs ?? 1;
      return active < max;
    });
    if (withCapacity) return withCapacity;

    // All at capacity — return cheapest (caller should check capacity)
    return sorted[0];
  }
}
