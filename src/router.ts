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

    const runningCandidate = candidates.find(
      (candidate) => this.podController.getStatus(candidate.id) === 'running'
    );

    return runningCandidate ?? candidates[0];
  }
}
