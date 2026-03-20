import { describe, expect, it } from 'vitest';

import { planCreateFromAlias } from '../src/create-flow.js';
import { PodRegistry } from '../src/registry.js';

describe('create flow planning', () => {
  it('returns a coherent create plan for a local-file alias', () => {
    const registry = new PodRegistry();

    const plan = planCreateFromAlias(registry, { alias: 'whisper' });

    expect(plan?.status).toBe('resolved');
    expect(plan?.resolvedSource.kind).toBe('local-file');
    expect(plan?.materialization.status).toBe('not-implemented');
    expect(plan?.materialization.nextAction).toContain('Validate local package content');
  });

  it('returns undefined for an unknown alias', () => {
    const registry = new PodRegistry();
    expect(planCreateFromAlias(registry, { alias: 'missing' })).toBeUndefined();
  });
});
