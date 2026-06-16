import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildPatch } from '../../studio/webview/lib/acurastConfig';

// End-to-end persistence of the processor whitelist. The whitelist editor (now a
// 2-column table) carries its value as a newline-joined string; buildPatch splits
// it into the array acurast.json stores. We drive the REAL buildPatch and the
// SAME VS Code fs read/write path StudioPanel.saveConfigPatch uses, against a real
// file, so the webview-string → on-disk-array contract is covered in a live host.
//
// StudioPanel.saveConfigPatch can't be imported here (its @acurast/sdk graph is
// ESM-only and this Mocha runtime is CJS), so saveLikeHost mirrors it exactly.
async function saveLikeHost(uri: vscode.Uri, projectKey: string, patch: Record<string, unknown>): Promise<void> {
  const data = await vscode.workspace.fs.readFile(uri);
  const json = JSON.parse(new TextDecoder('utf-8').decode(data)) as {
    projects: Record<string, Record<string, unknown>>;
  };
  json.projects[projectKey] = { ...json.projects[projectKey], ...patch };
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(json, null, 2) + '\n'));
}

suite('Processor whitelist persistence (real VS Code fs)', () => {
  let tmpDir: string;
  let uri: vscode.Uri;

  function writeConfig(project: Record<string, unknown>): void {
    fs.writeFileSync(uri.fsPath, JSON.stringify({ projects: { demo: project } }, null, 2) + '\n');
  }
  async function readProject(): Promise<Record<string, unknown>> {
    const data = await vscode.workspace.fs.readFile(uri);
    const json = JSON.parse(new TextDecoder('utf-8').decode(data)) as {
      projects: Record<string, Record<string, unknown>>;
    };
    return json.projects.demo;
  }

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acurast-wl-test-'));
    uri = vscode.Uri.file(path.join(tmpDir, 'acurast.json'));
  });
  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('persists the whitelist as a trimmed, gap-free array', async () => {
    writeConfig({ projectName: 'demo', fileUrl: './index.js' });

    const patch = buildPatch({ processorWhitelist: '5a\n 5b \n\n5c' }, await readProject());
    await saveLikeHost(uri, 'demo', patch);

    assert.deepStrictEqual((await readProject()).processorWhitelist, ['5a', '5b', '5c']);
  });

  test('clearing the whitelist persists an empty array (any processor allowed)', async () => {
    writeConfig({ projectName: 'demo', fileUrl: './index.js', processorWhitelist: ['5old'] });

    const patch = buildPatch({ processorWhitelist: '' }, await readProject());
    await saveLikeHost(uri, 'demo', patch);

    assert.deepStrictEqual((await readProject()).processorWhitelist, []);
  });

  test('writes canonical 2-space-indented JSON with a trailing newline', async () => {
    writeConfig({ projectName: 'demo', fileUrl: './index.js' });

    const patch = buildPatch({ processorWhitelist: '5a\n5b' }, await readProject());
    await saveLikeHost(uri, 'demo', patch);

    const raw = fs.readFileSync(uri.fsPath, 'utf-8');
    assert.strictEqual(raw, JSON.stringify(JSON.parse(raw), null, 2) + '\n');
  });
});
