import { readFile } from 'node:fs/promises';

import type { JobRequest, PodManifest, RunContext } from './types.js';

export interface PodAdapter {
  execute(manifest: PodManifest, request: JobRequest, context?: RunContext): Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class HttpPodAdapter implements PodAdapter {
  async execute(manifest: PodManifest, request: JobRequest, context?: RunContext): Promise<unknown> {
    const url = `${manifest.runtime.baseUrl}${manifest.runtime.submitPath}`;
    const method = manifest.runtime.method ?? 'POST';

    const init: RequestInit = {
      method,
      signal: context?.signal
    };

    const input = request.input ?? {};
    const filePath = typeof input.filePath === 'string' ? input.filePath : undefined;
    const fileField = typeof input.fileField === 'string' ? input.fileField : 'file';

    if (filePath) {
      const form = new FormData();
      const bytes = await readFile(filePath);
      const filename = typeof input.filename === 'string' ? input.filename : filePath.split('/').pop() ?? 'upload.bin';
      const contentType = typeof input.contentType === 'string' ? input.contentType : 'application/octet-stream';
      const blob = new Blob([bytes], { type: contentType });
      form.set(fileField, blob, filename);

      for (const [key, value] of Object.entries(input)) {
        if (key === 'filePath' || key === 'fileField' || key === 'filename' || key === 'contentType') continue;
        if (value === undefined || value === null) continue;
        form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }

      init.body = form;
    } else {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(input);
    }

    const response = await fetch(url, init);
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }

    if (!response.ok) {
      throw new Error(`Pod request failed (${response.status} ${response.statusText}) for ${manifest.id}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }

    return {
      podId: manifest.id,
      capability: request.capability,
      acceptedAt: new Date().toISOString(),
      submitUrl: url,
      method,
      response: parsed
    };
  }
}
