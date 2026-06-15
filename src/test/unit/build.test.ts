import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

// build.ts imports vscode for the `acurast.build` command entry; mock it so the
// module loads under Node. The helpers under test (readBuildConfig/runProjectBuild)
// don't touch vscode themselves.
vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    withProgress: vi.fn(),
  },
  workspace: { isTrusted: true },
  ProgressLocation: { Notification: 15 },
}));

// Controllable spawn — each test wires a fake child process.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock }));

import { readBuildConfig, runProjectBuild, isLocalPath } from '../../commands/build';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'acurast-build-test-'));
  spawnMock.mockReset();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(obj: unknown): string {
  const p = path.join(root, 'acurast.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe('readBuildConfig', () => {
  it('returns the build block for a single-project file', () => {
    const cfg = writeConfig({
      projects: { demo: { projectName: 'demo', fileUrl: 'i.js', build: { command: 'npm run build', output: 'dist/i.js' } } },
    });
    expect(readBuildConfig(cfg)).toEqual({
      projectKey: 'demo',
      build: { command: 'npm run build', cwd: undefined, output: 'dist/i.js' },
    });
  });

  it('returns undefined when the single project has no build', () => {
    const cfg = writeConfig({ projects: { demo: { projectName: 'demo', fileUrl: 'i.js' } } });
    expect(readBuildConfig(cfg)).toBeUndefined();
  });

  it('returns undefined for a multi-project file without a projectKey', () => {
    const cfg = writeConfig({ projects: { a: { build: { command: 'x' } }, b: { build: { command: 'y' } } } });
    expect(readBuildConfig(cfg)).toBeUndefined();
  });

  it('selects by object key for a multi-project file', () => {
    const cfg = writeConfig({ projects: { a: { build: { command: 'x' } }, b: { build: { command: 'y' } } } });
    expect(readBuildConfig(cfg, 'b')).toEqual({
      projectKey: 'b',
      build: { command: 'y', cwd: undefined, output: undefined },
    });
  });

  it('treats an empty command as no build', () => {
    const cfg = writeConfig({ projects: { demo: { build: { command: '   ' } } } });
    expect(readBuildConfig(cfg)).toBeUndefined();
  });

  it('returns undefined for malformed JSON instead of throwing', () => {
    const p = path.join(root, 'acurast.json');
    fs.writeFileSync(p, '{ not json');
    expect(readBuildConfig(p)).toBeUndefined();
  });
});

describe('isLocalPath', () => {
  it('treats relative/absolute paths as local', () => {
    expect(isLocalPath('dist/i.js')).toBe(true);
    expect(isLocalPath('/abs/i.js')).toBe(true);
  });
  it('treats ipfs/https/CID refs and undefined as non-local', () => {
    expect(isLocalPath('ipfs://QmHash')).toBe(false);
    expect(isLocalPath('https://example.com/x.js')).toBe(false);
    expect(isLocalPath(undefined)).toBe(false);
  });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
function fakeOut() {
  return { append: vi.fn(), appendLine: vi.fn() } as unknown as import('vscode').OutputChannel;
}

describe('runProjectBuild', () => {
  it('resolves on exit 0, verifies the output artifact, and streams output line-by-line', async () => {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'i.js'), '//built');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const out = fakeOut();
    const onStage = vi.fn();
    const onLog = vi.fn();

    const p = runProjectBuild({ projectRoot: root, build: { command: 'npm run build', output: 'dist/i.js' }, output: out, onStage, onLog });
    child.stdout.emit('data', Buffer.from('compiling\n'));
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith('npm run build', expect.objectContaining({ cwd: root, shell: true }));
    expect(out.appendLine).toHaveBeenCalledWith('compiling');
    expect(onLog).toHaveBeenCalledWith('info', 'compiling');
    expect(onStage).toHaveBeenNthCalledWith(1, 'start');
    expect(onStage).toHaveBeenLastCalledWith('done');
  });

  it('strips ANSI and routes stdout/stderr to onLog by level', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const onLog = vi.fn();
    const p = runProjectBuild({ projectRoot: root, build: { command: 'x' }, output: fakeOut(), onLog });
    child.stdout.emit('data', Buffer.from('\u001b[32mok\u001b[0m\n'));
    child.stderr.emit('data', Buffer.from('oops\n'));
    child.emit('close', 0);
    await p;
    expect(onLog).toHaveBeenCalledWith('info', 'ok');
    expect(onLog).toHaveBeenCalledWith('warn', 'oops');
  });

  it('flushes a trailing partial line (no newline) on close', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const onLog = vi.fn();
    const p = runProjectBuild({ projectRoot: root, build: { command: 'x' }, output: fakeOut(), onLog });
    child.stdout.emit('data', Buffer.from('no newline here'));
    child.emit('close', 0);
    await p;
    expect(onLog).toHaveBeenCalledWith('info', 'no newline here');
  });

  it('resolves the working directory against the project root', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = runProjectBuild({ projectRoot: root, build: { command: 'make', cwd: 'sub' }, output: fakeOut() });
    child.emit('close', 0);
    await p;
    expect(spawnMock.mock.calls[0][1].cwd).toBe(path.join(root, 'sub'));
  });

  it('rejects on a non-zero exit code', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = runProjectBuild({ projectRoot: root, build: { command: 'false' }, output: fakeOut() });
    child.emit('close', 2);
    await expect(p).rejects.toThrow('exited with code 2');
  });

  it('rejects when the declared output is missing after a successful build', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = runProjectBuild({ projectRoot: root, build: { command: 'noop', output: 'dist/missing.js' }, output: fakeOut() });
    child.emit('close', 0);
    await expect(p).rejects.toThrow('output not found');
  });

  it('skips the existence check for ipfs/https outputs', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = runProjectBuild({ projectRoot: root, build: { command: 'noop', output: 'ipfs://QmHash' }, output: fakeOut() });
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects when the command fails to start', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = runProjectBuild({ projectRoot: root, build: { command: 'nope' }, output: fakeOut() });
    child.emit('error', new Error('spawn ENOENT'));
    await expect(p).rejects.toThrow('Failed to start build command');
  });
});
