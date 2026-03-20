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
      baseUrl: 'http://127.0.0.1:8188',
      healthPath: '/system_stats',
      submitPath: '/prompt',
      method: 'POST'
    },
    startup: {
      command: 'docker compose up -d comfyapi',
      simulatedDelayMs: 250
    },
    shutdown: {
      command: 'docker compose stop comfyapi',
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
    description: 'Speech-to-text pod for local transcription and diarization-adjacent jobs.',
    capabilities: ['speech-to-text'],
    source: {
      homepage: 'https://github.com/openai/whisper',
      readme: 'https://github.com/openai/whisper#readme',
      repository: 'https://github.com/openai/whisper'
    },
    runtime: {
      kind: 'http-service',
      baseUrl: 'http://127.0.0.1:9000',
      healthPath: '/health',
      submitPath: '/transcribe',
      method: 'POST'
    },
    startup: {
      command: 'docker compose up -d whisper',
      simulatedDelayMs: 200
    },
    shutdown: {
      command: 'docker compose stop whisper',
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
      homepage: 'https://github.com/microsoft/unilm/tree/master/trocr',
      readme: 'https://huggingface.co/docs/transformers/model_doc/trocr',
      repository: 'https://github.com/microsoft/unilm'
    },
    runtime: {
      kind: 'http-service',
      baseUrl: 'http://127.0.0.1:9100',
      healthPath: '/health',
      submitPath: '/ocr',
      method: 'POST'
    },
    startup: {
      command: 'docker compose up -d ocr-vision',
      simulatedDelayMs: 150
    },
    shutdown: {
      command: 'docker compose stop ocr-vision',
      simulatedDelayMs: 75
    },
    exclusivityGroup: 'gpu-0',
    metadata: {
      packageManifestVersion: '1',
      packaged: true
    }
  }
];
