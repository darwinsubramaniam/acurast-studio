import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDeployEnvVars } from '../../lib/env';

// Integration coverage in the real (CommonJS-compiled) extension-host runtime:
// confirms dotenv parses a real `.env` on disk and that process.env fallback +
// missing-detection behave as the deploy flow relies on. Mirrors the "real fs"
// approach of context.test.ts.
suite('resolveDeployEnvVars — real .env on disk', () => {
  let tmpDir: string;
  const ORIGINAL_ENV = { ...process.env };

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acurast-env-suite-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('resolves whitelisted names from the project .env', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=hello\nBAR=world\n');
    const { envVars, missing } = resolveDeployEnvVars(tmpDir, ['FOO', 'BAR']);
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(envVars, [
      { key: 'FOO', value: 'hello' },
      { key: 'BAR', value: 'world' },
    ]);
  });

  test('prefers .env over process.env, falls back to process.env, reports the rest missing', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=fromfile\n');
    process.env.FOO = 'fromproc'; // .env must win
    process.env.BAR = 'fromproc'; // only in process.env
    delete process.env.NOPE;       // in neither
    const { envVars, missing } = resolveDeployEnvVars(tmpDir, ['FOO', 'BAR', 'NOPE']);
    assert.deepStrictEqual(envVars, [
      { key: 'FOO', value: 'fromfile' },
      { key: 'BAR', value: 'fromproc' },
    ]);
    assert.deepStrictEqual(missing, ['NOPE']);
  });

  test('treats an empty value (KEY=) as set, not missing', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=\n');
    assert.deepStrictEqual(resolveDeployEnvVars(tmpDir, ['FOO']), {
      envVars: [{ key: 'FOO', value: '' }],
      missing: [],
    });
  });

  test('empty/undefined whitelist short-circuits without touching the filesystem', () => {
    // No .env exists in tmpDir — must not throw and must return empty.
    assert.deepStrictEqual(resolveDeployEnvVars(tmpDir, []), { envVars: [], missing: [] });
    assert.deepStrictEqual(resolveDeployEnvVars(tmpDir, undefined), { envVars: [], missing: [] });
  });

  test('missing .env file falls back entirely to process.env', () => {
    process.env.FOO = 'fromproc';
    delete process.env.BAR;
    const { envVars, missing } = resolveDeployEnvVars(tmpDir, ['FOO', 'BAR']);
    assert.deepStrictEqual(envVars, [{ key: 'FOO', value: 'fromproc' }]);
    assert.deepStrictEqual(missing, ['BAR']);
  });
});
