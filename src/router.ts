import { SchedulingError } from './errors.js';
import { PodController } from './pod-controller.js';
import { PodRegistry } from './registry.js';
import type { JobRequest, PodCapability, PodManifest } from './types.js';

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
        throw new SchedulingError(`Preferred pod not found: ${request.preferredPodId}`);
      }

      return preferred;
    }

    const capability = request.capability ?? this.inferCapability(request.type);
    const candidates = this.registry.findByCapability(capability);

    if (candidates.length === 0) {
      throw new SchedulingError(`No pod registered for capability: ${capability}`);
    }

    const runningCandidate = candidates.find(
      (candidate) => this.podController.getStatus(candidate.id) === 'running'
    );

    return runningCandidate ?? candidates[0];
  }

  private inferCapability(type: string): PodCapability {
    const lowered = type.toLowerCase();
    if (lowered.includes('transcrib') || lowered.includes('speech') || lowered.includes('audio')) {
      return 'speech-to-text';
    }
    if (lowered.includes('ocr') || lowered.includes('extract-text')) {
      return 'ocr';
    }
    if (lowered.includes('vision')) {
      return 'vision';
    }
    if (lowered.includes('image') || lowered.includes('render') || lowered.includes('generate')) {
      return 'image-generation';
    }

    throw new SchedulingError(`Unable to infer capability for job type: ${type}`);
  }
}
