import { describe, expect, it } from 'vitest';

import { createFailedResult, normalizeCompletedResult } from '../src/job-contracts.js';
import type { JobRequest, PodManifest } from '../src/types.js';

const manifest: PodManifest = {
  id: 'whisper',
  nickname: 'Whisper',
  description: 'Speech to text pod',
  capabilities: ['speech-to-text', 'ocr', 'vision', 'image-generation'],
  source: {},
  runtime: {
    kind: 'http-service',
    baseUrl: 'http://127.0.0.1:8001',
    submitPath: '/jobs'
  }
};

describe('job contract normalization', () => {
  it('normalizes speech-to-text output into a transcript contract', () => {
    const request: JobRequest = {
      type: 'transcribe-audio',
      input: { audioUrl: 'file:///tmp/demo.wav' }
    };

    const result = normalizeCompletedResult(manifest, request, 'speech-to-text', {
      response: {
        transcript: 'hello from the abyss',
        language: 'en',
        durationMs: 1200,
        segments: [
          { startMs: 0, endMs: 500, text: 'hello', confidence: 0.98 },
          { startMs: 500, endMs: 1200, text: 'from the abyss', confidence: 0.97 }
        ]
      }
    });

    expect(result.output.kind).toBe('speech-to-text');
    if (result.output.kind !== 'speech-to-text') {
      throw new Error('Expected speech-to-text output');
    }
    expect(result.output.transcript?.text).toBe('hello from the abyss');
    expect(result.output.transcript?.segments).toHaveLength(2);
    expect(result.output.raw).toBeTruthy();
  });

  it('normalizes OCR output into text plus detections', () => {
    const request: JobRequest = {
      type: 'ocr-document',
      input: { imageUrl: 'file:///tmp/demo.png' }
    };

    const result = normalizeCompletedResult(manifest, request, 'ocr', {
      response: {
        text: 'INVOICE',
        detections: [
          {
            label: 'word',
            text: 'INVOICE',
            confidence: 0.99,
            box: { x: 1, y: 2, width: 100, height: 20 }
          }
        ]
      }
    });

    expect(result.output.kind).toBe('ocr');
    if (result.output.kind !== 'ocr') {
      throw new Error('Expected ocr output');
    }
    expect(result.output.text).toBe('INVOICE');
    expect(result.output.detections?.[0].box?.width).toBe(100);
  });

  it('normalizes image generation output into generatedImages', () => {
    const request: JobRequest = {
      type: 'generate-image',
      input: { prompt: 'snark imp' }
    };

    const result = normalizeCompletedResult(manifest, request, 'image-generation', {
      response: {
        images: [
          {
            url: 'https://example.com/image.png',
            filename: 'image.png',
            contentType: 'image/png',
            width: 1024,
            height: 1024
          }
        ]
      }
    });

    expect(result.output.kind).toBe('image-generation');
    if (result.output.kind !== 'image-generation') {
      throw new Error('Expected image-generation output');
    }
    expect(result.output.generatedImages?.[0].url).toContain('image.png');
    expect(result.output.generatedImages?.[0].width).toBe(1024);
  });

  it('keeps failed results coherent with capability-specific output kinds', () => {
    const request: JobRequest = {
      type: 'transcribe-audio',
      input: { audioUrl: 'file:///tmp/demo.wav' }
    };

    const result = createFailedResult(manifest, request, 'speech-to-text', new Error('boom'));
    expect(result.status).toBe('failed');
    expect(result.output.kind).toBe('speech-to-text');
    expect(result.output.error?.code).toBe('INTERNAL_ERROR');
  });
});
