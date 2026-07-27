import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';

// deploy.ts pulls in vscode and the SDK at module load; stub them so the pure
// path helper under test can be imported under Node. Mirrors build.test.ts.
vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showInputBox: vi.fn(),
    withProgress: vi.fn(),
  },
  workspace: { isTrusted: true },
  ProgressLocation: { Notification: 15 },
}));
vi.mock('@acurast/sdk/deploy', () => ({ deployProject: vi.fn(), loadAcurastConfig: vi.fn() }));
vi.mock('@acurast/sdk/chain', () => ({ walletFromMnemonic: vi.fn(), convertConfigToJob: vi.fn() }));

import { resolveAgainst } from '../../commands/deploy';

const root = path.resolve('/home/user/project');

describe('resolveAgainst', () => {
  it('passes an absent fileUrl through', () => {
    expect(resolveAgainst(root, undefined)).toBeUndefined();
    expect(resolveAgainst(root, '')).toBe('');
  });

  it('resolves a relative path against the project root', () => {
    expect(resolveAgainst(root, 'index.js')).toBe(path.join(root, 'index.js'));
    expect(resolveAgainst(root, './dist/bundle.js')).toBe(path.join(root, 'dist', 'bundle.js'));
    expect(resolveAgainst(root, 'a/../b.js')).toBe(path.join(root, 'b.js'));
  });

  it('keeps an absolute path that is already inside the project', () => {
    const inside = path.join(root, 'dist', 'app.js');
    expect(resolveAgainst(root, inside)).toBe(inside);
  });

  it('rejects parent traversal out of the project', () => {
    expect(() => resolveAgainst(root, '../../../../etc/passwd')).toThrow(/outside the project/);
    expect(() => resolveAgainst(root, '..')).toThrow(/outside the project/);
  });

  it('rejects an absolute path pointing elsewhere on disk', () => {
    expect(() => resolveAgainst(root, '/etc/passwd')).toThrow(/fileUrl/);
    expect(() => resolveAgainst(root, '/home/user/.ssh/id_rsa')).toThrow(/outside the project/);
  });

  it('rejects a sibling directory that merely shares the root prefix', () => {
    expect(() => resolveAgainst(root, `${root}-evil/x.js`)).toThrow(/outside the project/);
  });

  // Regression guard: remote references must reach the SDK byte-for-byte. Tightening
  // the containment check must never start rewriting (or rejecting) these.
  it('passes remote references through unchanged', () => {
    const remotes = [
      'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
      'https://example.com/bundle.js',
      'http://example.com/bundle.js',
      'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    ];
    for (const ref of remotes) {
      expect(resolveAgainst(root, ref)).toBe(ref);
    }
  });
});
