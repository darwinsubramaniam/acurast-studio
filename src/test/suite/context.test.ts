import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AcurastContext } from '../../context';

const STATE_KEY = 'acurast.activeConfigPath';

function fakeExtensionContext(stored?: string) {
  const store = new Map<string, unknown>();
  if (stored !== undefined) store.set(STATE_KEY, stored);
  const ctx = {
    workspaceState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
      keys: () => [...store.keys()],
    },
    subscriptions: [] as { dispose(): void }[],
  } as unknown as vscode.ExtensionContext;
  return { ctx, store };
}

suite('AcurastContext — stored config detection (real fs)', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acurast-ctx-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('adopts the stored config when the file exists on disk', async () => {
    const configPath = path.join(tmpDir, 'acurast.json');
    fs.writeFileSync(configPath, '{}');
    const { ctx } = fakeExtensionContext(configPath);

    const context = new AcurastContext(ctx);
    await context.initialize();

    assert.strictEqual(context.configPath, configPath);
    assert.strictEqual(context.isAcurastProject, true);
  });

  test('does not pin a stored config whose file was deleted/moved', async () => {
    // Path under tmpDir (outside the workspace), never created → stat fails.
    const missingPath = path.join(tmpDir, 'gone', 'acurast.json');
    const { ctx, store } = fakeExtensionContext(missingPath);

    const context = new AcurastContext(ctx);
    await context.initialize();

    // The dead pointer must not be adopted, and the stale workspaceState entry
    // must be cleared. (configPath may resolve to a real config if the test host
    // happens to have one open, but it must never be the missing path.)
    assert.notStrictEqual(context.configPath, missingPath, 'dead path must not be pinned');
    assert.strictEqual(store.has(STATE_KEY), false, 'stale stored pointer must be cleared');
  });
});
