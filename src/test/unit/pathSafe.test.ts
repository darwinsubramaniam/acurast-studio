import { describe, it, expect } from 'vitest';
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
