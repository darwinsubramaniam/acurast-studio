import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDeployEnvVars } from '../../lib/env';

let root: string;
const ORIGINAL_ENV = { ...process.env };

function writeEnv(contents: string) {
  fs.writeFileSync(path.join(root, '.env'), contents);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'acurast-env-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveDeployEnvVars', () => {
  it('returns empty result when the whitelist is undefined', () => {
    expect(resolveDeployEnvVars(root, undefined)).toEqual({ envVars: [], missing: [] });
  });

  it('returns empty result when the whitelist is empty (no .env read)', () => {
    expect(resolveDeployEnvVars(root, [])).toEqual({ envVars: [], missing: [] });
  });

  it('resolves a value present in .env', () => {
    writeEnv('FOO=hello\n');
    expect(resolveDeployEnvVars(root, ['FOO'])).toEqual({
      envVars: [{ key: 'FOO', value: 'hello' }],
      missing: [],
    });
  });

  it('treats an empty value (KEY=) as intentionally set, not missing', () => {
    writeEnv('FOO=\n');
    expect(resolveDeployEnvVars(root, ['FOO'])).toEqual({
      envVars: [{ key: 'FOO', value: '' }],
      missing: [],
    });
  });

  it('falls back to process.env when the name is absent from .env', () => {
    writeEnv('FOO=fromfile\n');
    process.env.BAR = 'fromproc';
    const { envVars, missing } = resolveDeployEnvVars(root, ['FOO', 'BAR']);
    expect(missing).toEqual([]);
    expect(envVars).toEqual([
      { key: 'FOO', value: 'fromfile' },
      { key: 'BAR', value: 'fromproc' },
    ]);
  });

  it('prefers the .env value over process.env', () => {
    writeEnv('FOO=fromfile\n');
    process.env.FOO = 'fromproc';
    expect(resolveDeployEnvVars(root, ['FOO'])).toEqual({
      envVars: [{ key: 'FOO', value: 'fromfile' }],
      missing: [],
    });
  });

  it('reports names absent from both sources as missing', () => {
    writeEnv('FOO=hello\n');
    delete process.env.NOPE;
    const { envVars, missing } = resolveDeployEnvVars(root, ['FOO', 'NOPE']);
    expect(envVars).toEqual([{ key: 'FOO', value: 'hello' }]);
    expect(missing).toEqual(['NOPE']);
  });

  it('falls back to process.env when no .env file exists', () => {
    process.env.FOO = 'fromproc';
    delete process.env.BAR;
    const { envVars, missing } = resolveDeployEnvVars(root, ['FOO', 'BAR']);
    expect(envVars).toEqual([{ key: 'FOO', value: 'fromproc' }]);
    expect(missing).toEqual(['BAR']);
  });
});
