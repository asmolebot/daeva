import type { PodManifest } from '../types.js';

export const builtinManifests: PodManifest[] = [
  {
    id: 'comfyapi',
    nickname: 'Comfy',
    description: 'ComfyUI-style image generation pod for prompt-driven GPU jobs.',
    capabilities: ['image-generation', 'vision'],
    source: {
      homepage: 'https://github.com/comfyanonymous/ComfyUI',
      readme: 'https://github.com/comfyanonymous/ComfyUI#readme',
      repository: 'https://github.com/comfyanonymous/ComfyUI'
    },
    runtime: {
      kind: 'http-service',
      baseUrl: 'http://127.0.0.1:3000',
      healthPath: '/health',
      submitPath: '/prompt',
      method: 'POST'
    },
    startup: {
      command: `sh -lc 'podman container exists comfyapi && podman start comfyapi || podman run -d --name comfyapi --replace --device nvidia.com/gpu=all -p 3000:3000 -p 8188:8188 -v /home/clohl/ai/comfy/models:/opt/ComfyUI/models -v /home/clohl/ai/comfy/input:/opt/ComfyUI/input -v /home/clohl/ai/comfy/output:/opt/ComfyUI/output -v /home/clohl/ai/comfy/workflows:/opt/ComfyUI/user/default/workflows -v /home/clohl/ai/comfy/temp:/opt/ComfyUI/temp -v /home/clohl/ai/comfy/custom_nodes:/opt/ComfyUI/custom_nodes ghcr.io/saladtechnologies/comfyui-api:comfy0.12.3-api1.17.1-torch2.8.0-cuda12.8-runtime'`,
      simulatedDelayMs: 250
    },
    shutdown: {
      command: 'podman stop comfyapi',
      simulatedDelayMs: 150
    },
    exclusivityGroup: 'gpu-0',
    metadata: {
      packageManifestVersion: '1',
      packaged: true
    }
  },
  {
    id: 'whisper',
    nickname: 'Whisper',
    description: 'Speech-to-text pod for local transcription jobs.',
    capabilities: ['speech-to-text'],
    source: {
      homepage: 'https://github.com/openai/whisper',
      readme: 'https://github.com/openai/whisper#readme',
      repository: 'https://github.com/openai/whisper'
    },
    runtime: {
      kind: 'http-service',
      baseUrl: 'http://127.0.0.1:8001',
      healthPath: '/health',
      submitPath: '/transcribe',
      method: 'POST'
    },
    startup: {
      command: `sh -lc 'podman container exists asmo-whisper && podman start asmo-whisper || podman run -d --name asmo-whisper --replace --device nvidia.com/gpu=all -p 8001:8001 -e WHISPER_MODEL=large-v3-turbo -e WHISPER_COMPUTE_TYPE=float16 -e WHISPER_DEVICE=cuda -v /home/clohl/ai/services/whisper/models:/models docker.io/library/asmo-whisper:latest'`,
      simulatedDelayMs: 200
    },
    shutdown: {
      command: 'podman stop asmo-whisper',
      simulatedDelayMs: 100
    },
    exclusivityGroup: 'gpu-0',
    metadata: {
      packageManifestVersion: '1',
      packaged: true
    }
  },
  {
    id: 'ocr-vision',
    nickname: 'OCR Vision',
    description: 'OCR and vision pod for extracting text and basic image understanding.',
    capabilities: ['ocr', 'vision'],
    source: {
      homepage: 'https://github.com/JaidedAI/EasyOCR',
      readme: 'https://github.com/JaidedAI/EasyOCR#readme',
      repository: 'https://github.com/JaidedAI/EasyOCR'
    },
    runtime: {
      kind: 'http-service',
      baseUrl: 'http://127.0.0.1:8002',
      healthPath: '/health',
      submitPath: '/ocr/image',
      method: 'POST'
    },
    startup: {
      command: `sh -lc 'podman container exists asmo-ocr-vision && podman start asmo-ocr-vision || podman run -d --name asmo-ocr-vision --replace --device nvidia.com/gpu=all -p 8002:8002 -e OCR_LANGS=en -e OCR_GPU=true -v /home/clohl/ai/services/ocr-vision/models:/models docker.io/library/asmo-ocr-vision:latest'`,
      simulatedDelayMs: 150
    },
    shutdown: {
      command: 'podman stop asmo-ocr-vision',
      simulatedDelayMs: 75
    },
    exclusivityGroup: 'gpu-0',
    metadata: {
      packageManifestVersion: '1',
      packaged: true
    }
  }
];
