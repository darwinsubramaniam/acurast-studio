import { describe, it, expect } from 'vitest';
import { buildPatch, validateConfig, getNested, instantMatchField } from '../../studio/webview/lib/acurastConfig';

describe('getNested', () => {
  it('walks a key path', () => {
    expect(getNested({ a: { b: { c: 1 } } }, 'a', 'b', 'c')).toBe(1);
  });
  it('returns undefined when a hop is missing', () => {
    expect(getNested({ a: {} }, 'a', 'b', 'c')).toBeUndefined();
    expect(getNested({ a: 5 }, 'a', 'b')).toBeUndefined();
  });
});

describe('instantMatchField', () => {
  it('reads from the SDK array shape', () => {
    const p = { assignmentStrategy: { instantMatch: [{ processor: '5x', maxAllowedStartDelayInMs: 200 }] } };
    expect(instantMatchField(p, 'processor')).toBe('5x');
    expect(instantMatchField(p, 'maxAllowedStartDelayInMs')).toBe(200);
  });
  it('reads from the legacy single-object shape', () => {
    const p = { assignmentStrategy: { instantMatch: { processor: '5y' } } };
    expect(instantMatchField(p, 'processor')).toBe('5y');
  });
  it('returns undefined when absent', () => {
    expect(instantMatchField({}, 'processor')).toBeUndefined();
  });
});

describe('buildPatch', () => {
  it('splits comma-separated env vars and trims/drops empties', () => {
    const patch = buildPatch({ includeEnvironmentVariables: 'A, B ,,C' }, {});
    expect(patch.includeEnvironmentVariables).toEqual(['A', 'B', 'C']);
  });

  it('splits the whitelist on newlines', () => {
    const patch = buildPatch({ processorWhitelist: 'a\n b \n\nc' }, {});
    expect(patch.processorWhitelist).toEqual(['a', 'b', 'c']);
  });

  it('parses reuseKeysFrom, treating empty/null as null and skipping invalid JSON', () => {
    expect(buildPatch({ reuseKeysFrom: '' }, {}).reuseKeysFrom).toBeNull();
    expect(buildPatch({ reuseKeysFrom: 'null' }, {}).reuseKeysFrom).toBeNull();
    expect(buildPatch({ reuseKeysFrom: '["Acurast","5a",1]' }, {}).reuseKeysFrom).toEqual(['Acurast', '5a', 1]);
    expect('reuseKeysFrom' in buildPatch({ reuseKeysFrom: 'not json' }, {})).toBe(false);
  });

  it('expands dotted keys into nested objects', () => {
    const patch = buildPatch({ 'image.url': 'u', 'image.sha256': 's' }, {});
    expect(patch.image).toEqual({ url: 'u', sha256: 's' });
  });

  it('deep-merges nested objects onto the original project', () => {
    const patch = buildPatch({ 'image.url': 'new' }, { image: { url: 'old', sha256: 'keep' } });
    expect(patch.image).toEqual({ url: 'new', sha256: 'keep' });
  });

  it('normalizes a Single instantMatch into the SDK array shape with a default delay', () => {
    const patch = buildPatch(
      { 'assignmentStrategy.type': 'Single', 'assignmentStrategy.instantMatch.processor': '5proc' },
      {},
    );
    expect(patch.assignmentStrategy).toEqual({
      type: 'Single',
      instantMatch: [{ processor: '5proc', maxAllowedStartDelayInMs: 10000 }],
    });
  });

  it('drops instantMatch entirely for a Competing strategy', () => {
    const patch = buildPatch(
      { 'assignmentStrategy.type': 'Competing', 'assignmentStrategy.instantMatch.processor': '5proc' },
      {},
    );
    expect(patch.assignmentStrategy).toEqual({ type: 'Competing' });
  });

  it('nulls out minProcessorVersions when no version is set', () => {
    const patch = buildPatch({ 'minProcessorVersions.android': '' }, {});
    expect(patch.minProcessorVersions).toBeNull();
  });
});

describe('validateConfig', () => {
  it('returns no errors when there is no project', () => {
    expect(validateConfig({}, null)).toEqual({});
  });

  it('flags missing required fields', () => {
    expect(validateConfig({}, {})).toEqual({ projectName: 'Required', fileUrl: 'Required' });
  });

  it('passes a minimal valid project', () => {
    expect(validateConfig({}, { projectName: 'x', fileUrl: 'f' })).toEqual({});
  });

  it('requires image url + 64-hex sha256 for the Shell runtime', () => {
    const errs = validateConfig(
      { 'image.url': 'u', 'image.sha256': 'zz' },
      { projectName: 'x', fileUrl: 'f', runtime: 'Shell' },
    );
    expect(errs['image.sha256']).toBe('Must be 64-character hex string');
    expect(errs['image.url']).toBeUndefined();
  });

  it('requires interval + numberOfExecutions for interval execution', () => {
    const errs = validateConfig(
      { 'execution.type': 'interval' },
      { projectName: 'x', fileUrl: 'f' },
    );
    expect(errs['execution.intervalInMs']).toBe('Required, must be > 0');
    expect(errs['execution.numberOfExecutions']).toBe('Required, positive integer');
  });

  it('validates reuseKeysFrom JSON and shape', () => {
    const base = { projectName: 'x', fileUrl: 'f' };
    expect(validateConfig({ reuseKeysFrom: 'not json' }, base).reuseKeysFrom).toBe('Invalid JSON');
    expect(validateConfig({ reuseKeysFrom: '[1,2,3]' }, base).reuseKeysFrom).toBe('Must be ["Acurast", "address", deploymentId]');
    expect(validateConfig({ reuseKeysFrom: '["Acurast","5a",1]' }, base).reuseKeysFrom).toBeUndefined();
  });
});
