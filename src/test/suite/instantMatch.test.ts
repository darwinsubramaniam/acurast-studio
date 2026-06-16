import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildPatch } from '../../studio/webview/lib/acurastConfig';

// End-to-end persistence of the instant-match processor list. instantMatch is an
// array that can hold zero/one/many processors, each with its own start delay.
// We drive the REAL buildPatch (the new array shaping) and the SAME VS Code fs
// read/write path StudioPanel.saveConfigPatch uses, against a real file, so the
// whole webview-draft → on-disk acurast.json contract is covered in a live host.
//
// StudioPanel.saveConfigPatch can't be imported here (its @acurast/sdk graph is
// ESM-only and this Mocha runtime is CJS — see studioPanel.deregister unit test),
// so saveLikeHost mirrors its read/shallow-merge/write exactly.
async function saveLikeHost(uri: vscode.Uri, projectKey: string, patch: Record<string, unknown>): Promise<void> {
  const data = await vscode.workspace.fs.readFile(uri);
  const json = JSON.parse(new TextDecoder('utf-8').decode(data)) as {
    projects: Record<string, Record<string, unknown>>;
  };
  json.projects[projectKey] = { ...json.projects[projectKey], ...patch };
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(json, null, 2) + '\n'));
}

suite('Instant-match config persistence (real VS Code fs)', () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acurast-im-test-'));
    uri = vscode.Uri.file(path.join(tmpDir, 'acurast.json'));
  });
  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('persists a multi-entry instantMatch array with per-processor delays', async () => {
    writeConfig({ projectName: 'demo', fileUrl: './index.js', assignmentStrategy: { type: 'Single' } });

    const patch = buildPatch(
      {
        'assignmentStrategy.type': 'Single',
        'assignmentStrategy.instantMatch': [
          { processor: '5a', maxAllowedStartDelayInMs: 5000 },
          { processor: '5b', maxAllowedStartDelayInMs: 30000 },
        ],
      },
      await readProject(),
    );
    await saveLikeHost(uri, 'demo', patch);

    assert.deepStrictEqual((await readProject()).assignmentStrategy, {
      type: 'Single',
      instantMatch: [
        { processor: '5a', maxAllowedStartDelayInMs: 5000 },
        { processor: '5b', maxAllowedStartDelayInMs: 30000 },
      ],
    });
  });

  test('writes canonical 2-space-indented JSON with a trailing newline', async () => {
    writeConfig({ projectName: 'demo', fileUrl: './index.js' });

    const patch = buildPatch(
      { 'assignmentStrategy.type': 'Single', 'assignmentStrategy.instantMatch': [{ processor: '5a', maxAllowedStartDelayInMs: 5000 }] },
      await readProject(),
    );
    await saveLikeHost(uri, 'demo', patch);

    const raw = fs.readFileSync(uri.fsPath, 'utf-8');
    assert.strictEqual(raw, JSON.stringify(JSON.parse(raw), null, 2) + '\n');
    assert.ok(Array.isArray((JSON.parse(raw).projects.demo.assignmentStrategy as Record<string, unknown>).instantMatch));
  });

  test('clearing the processor list drops instantMatch (open matching) but keeps the strategy', async () => {
    writeConfig({
      projectName: 'demo',
      fileUrl: './index.js',
      assignmentStrategy: { type: 'Single', instantMatch: [{ processor: '5a', maxAllowedStartDelayInMs: 5000 }] },
    });

    const patch = buildPatch(
      { 'assignmentStrategy.type': 'Single', 'assignmentStrategy.instantMatch': [] },
      await readProject(),
    );
    await saveLikeHost(uri, 'demo', patch);

    const saved = await readProject();
    assert.deepStrictEqual(saved.assignmentStrategy, { type: 'Single' });
    assert.ok(!('instantMatch' in (saved.assignmentStrategy as Record<string, unknown>)));
  });

  test('switching to Competing removes a stored instantMatch array', async () => {
    writeConfig({
      projectName: 'demo',
      fileUrl: './index.js',
      assignmentStrategy: { type: 'Single', instantMatch: [{ processor: '5a', maxAllowedStartDelayInMs: 5000 }] },
    });

    const patch = buildPatch(
      { 'assignmentStrategy.type': 'Competing', 'assignmentStrategy.instantMatch': [{ processor: '5a', maxAllowedStartDelayInMs: 5000 }] },
      await readProject(),
    );
    await saveLikeHost(uri, 'demo', patch);

    assert.deepStrictEqual((await readProject()).assignmentStrategy, { type: 'Competing' });
  });
});
