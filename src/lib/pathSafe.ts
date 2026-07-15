import * as path from 'path';

/**
 * True when `candidate` resolves to `root` itself or something nested inside it.
 * Used to keep config-controlled paths (acurast.json `fileUrl`, `build.cwd`,
 * `build.output`) from escaping the project directory via `../` traversal or an
 * absolute path pointing elsewhere on disk.
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  // Empty → candidate IS root. A leading `..` or an absolute rel means it escaped.
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolve `candidate` against `root` and assert it stays inside `root`, throwing a
 * descriptive error otherwise. Returns the absolute, contained path.
 */
export function resolveWithinRoot(root: string, candidate: string, label = 'path'): string {
  const resolved = path.resolve(root, candidate);
  if (!isPathWithinRoot(root, resolved)) {
    throw new Error(
      `Refusing to use ${label} "${candidate}": it resolves outside the project directory (${root}).`,
    );
  }
  return resolved;
}
