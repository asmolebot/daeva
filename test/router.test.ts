import { describe, expect, it } from 'vitest';

import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import { SchedulerRouter } from '../src/router.js';

const registry = new PodRegistry();

describe('SchedulerRouter', () => {
  it('routes image jobs to comfyapi by inferred capability', async () => {
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);

    const pod = await router.route({
      type: 'generate-image',
      input: { prompt: 'tiny chaos goblin' }
    });

    expect(pod.id).toBe('comfyapi');
    expect(controller.getStatus('comfyapi')).toBe('running');
  });

  it('stops a conflicting pod in the same exclusivity group before starting another', async () => {
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const comfy = registry.get('comfyapi');

    if (!comfy) {
      throw new Error('Missing comfyapi manifest');
    }

    await controller.start(comfy);
    expect(controller.getStatus('comfyapi')).toBe('running');

    const whisperPod = await router.route({
      type: 'transcribe-audio',
      input: { audioUrl: 'file:///tmp/audio.wav' }
    });

    expect(whisperPod.id).toBe('whisper');
    expect(controller.getStatus('comfyapi')).toBe('stopped');
    expect(controller.getStatus('whisper')).toBe('running');
  });
});
