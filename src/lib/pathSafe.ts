import * as path from 'path';
import * as fs from 'fs';

/**
 * True when `candidate` resolves to `root` itself or something nested inside it.
 * Used to keep config-controlled paths (acurast.json `fileUrl`, `build.cwd`,
 * `build.output`) from escaping the project directory via `../` traversal or an
 * absolute path pointing elsewhere on disk.
 *
 * Lexical only — it does not follow symlinks. Callers that will actually read or
 * execute the path want `resolveWithinRoot`, which adds the symlink check.
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  // Empty → candidate IS root. A leading `..` or an absolute rel means it escaped.
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolve the deepest existing ancestor of `p` through symlinks and re-join the
 * not-yet-existing tail.
 *
 * Plain `fs.realpathSync` throws ENOENT on a path that hasn't been created yet —
 * which `build.output` legitimately hasn't, since it's checked before the build
 * produces it. Walking up to the first existing ancestor still catches the escape
 * (a link can only be crossed at a component that exists) while letting an absent
 * leaf through. Falls back to the lexical path if nothing resolves.
 */
function realpathDeepest(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // hit the filesystem root
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolve `candidate` against `root` and assert it stays inside `root`, throwing a
 * descriptive error otherwise. Returns the absolute, contained path.
 *
 * Checked twice, because `path.resolve` is purely lexical while `fs.statSync` — and
 * the SDK's read of `fileUrl`, and `spawn`'s `cwd` — follow symlinks. A link planted
 * inside the project (`ln -s ~/.ssh/id_rsa payload.js`) passes the lexical test and
 * would still be read and uploaded, so the resolved target is checked as well. Both
 * sides are realpath'd: on macOS the project itself can sit behind a symlink
 * (/tmp → /private/tmp, /var → /private/var), and comparing a resolved candidate
 * against an unresolved root would reject perfectly legitimate paths.
 *
 * Returns the lexical path, not the realpath — callers should see the location the
 * user configured, not wherever the filesystem redirected it.
 */
export function resolveWithinRoot(root: string, candidate: string, label = 'path'): string {
  const resolved = path.resolve(root, candidate);
  const reject = () => {
    throw new Error(
      `Refusing to use ${label} "${candidate}": it resolves outside the project directory (${root}).`,
    );
  };
  if (!isPathWithinRoot(root, resolved)) reject();
  if (!isPathWithinRoot(realpathDeepest(root), realpathDeepest(resolved))) reject();
  return resolved;
}
