import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPathWithinRoot, resolveWithinRoot } from '../../lib/pathSafe';

const root = path.resolve('/home/user/project');

describe('isPathWithinRoot', () => {
  it('accepts the root itself and nested paths', () => {
    expect(isPathWithinRoot(root, root)).toBe(true);
    expect(isPathWithinRoot(root, path.join(root, 'dist', 'index.js'))).toBe(true);
    expect(isPathWithinRoot(root, path.join(root, 'a', '..', 'b'))).toBe(true);
  });

  it('rejects parent traversal and sibling escapes', () => {
    expect(isPathWithinRoot(root, path.join(root, '..'))).toBe(false);
    expect(isPathWithinRoot(root, path.join(root, '..', '..', 'etc', 'passwd'))).toBe(false);
    expect(isPathWithinRoot(root, '/home/user/project-evil')).toBe(false);
  });

  it('rejects absolute paths pointing elsewhere on disk', () => {
    expect(isPathWithinRoot(root, '/etc/passwd')).toBe(false);
    expect(isPathWithinRoot(root, '/home/user/.ssh/id_rsa')).toBe(false);
  });
});

describe('resolveWithinRoot', () => {
  it('resolves a contained relative path to an absolute path', () => {
    expect(resolveWithinRoot(root, 'dist/index.js')).toBe(path.join(root, 'dist', 'index.js'));
  });

  it('throws for a traversal that escapes the root', () => {
    expect(() => resolveWithinRoot(root, '../../etc/passwd', 'fileUrl')).toThrow(/outside the project/);
  });

  it('throws for an absolute path outside the root', () => {
    expect(() => resolveWithinRoot(root, '/home/user/.ssh/id_rsa', 'fileUrl')).toThrow(/fileUrl/);
  });
});

// The cases above are pure string math against paths that don't exist. These run
// against a real directory, because `path.resolve` is lexical: it does not follow
// symlinks, but `fs.statSync` (and the SDK's read of `fileUrl`) does. A link placed
// inside the project is the escape hatch that lexical containment can't see.
describe('resolveWithinRoot against a real filesystem', () => {
  let tmp: string;
  let realRoot: string;
  let outside: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acurast-pathsafe-test-'));
    realRoot = path.join(tmp, 'project');
    outside = path.join(tmp, 'secret.txt');
    fs.mkdirSync(path.join(realRoot, 'dist'), { recursive: true });
    fs.writeFileSync(outside, 'ssh-rsa AAAA…');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('still accepts genuinely contained paths on a real (possibly symlinked) tmpdir', () => {
    // os.tmpdir() is itself behind a symlink on macOS (/var → /private/var), so this
    // guards against a realpath check that rejects every legitimate path.
    fs.writeFileSync(path.join(realRoot, 'index.js'), '');
    expect(resolveWithinRoot(realRoot, 'index.js')).toBe(path.join(realRoot, 'index.js'));
    expect(resolveWithinRoot(realRoot, 'dist')).toBe(path.join(realRoot, 'dist'));
  });

  it('accepts a contained path that does not exist yet (build.output before the build)', () => {
    expect(resolveWithinRoot(realRoot, 'dist/bundle.js', 'build.output')).toBe(
      path.join(realRoot, 'dist', 'bundle.js'),
    );
  });

  it('rejects a file symlink inside the project that points outside it', () => {
    fs.symlinkSync(outside, path.join(realRoot, 'payload.js'));
    expect(() => resolveWithinRoot(realRoot, 'payload.js', 'fileUrl')).toThrow(/outside the project/);
  });

  it('rejects a directory symlink inside the project (build.cwd escape)', () => {
    const escape = path.join(tmp, 'elsewhere');
    fs.mkdirSync(escape);
    fs.symlinkSync(escape, path.join(realRoot, 'linked'));
    expect(() => resolveWithinRoot(realRoot, 'linked', 'build.cwd')).toThrow(/outside the project/);
  });

  it('rejects a path that traverses through a symlinked directory', () => {
    const escape = path.join(tmp, 'elsewhere');
    fs.mkdirSync(escape);
    fs.writeFileSync(path.join(escape, 'app.js'), '');
    fs.symlinkSync(escape, path.join(realRoot, 'linked'));
    expect(() => resolveWithinRoot(realRoot, 'linked/app.js', 'fileUrl')).toThrow(/outside the project/);
  });

  it('accepts a symlink that stays inside the project', () => {
    fs.writeFileSync(path.join(realRoot, 'real.js'), '');
    fs.symlinkSync(path.join(realRoot, 'real.js'), path.join(realRoot, 'alias.js'));
    expect(resolveWithinRoot(realRoot, 'alias.js')).toBe(path.join(realRoot, 'alias.js'));
  });
});
