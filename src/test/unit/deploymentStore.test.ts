import { describe, it, expect } from 'vitest';
import type * as vscode from 'vscode';
import { DeploymentStore } from '../../deployments/deploymentStore';
import type { StoredDeployment } from '../../studio/types';

// Minimal in-memory Memento so the store can be exercised without VS Code.
function fakeMemento(initial: Record<string, unknown> = {}): vscode.Memento {
  const state = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (<T>(key: string, def?: T) => (state.has(key) ? state.get(key) : def)) as vscode.Memento['get'],
    update: async (key: string, value: unknown) => { state.set(key, value); },
    keys: () => [...state.keys()],
  } as vscode.Memento;
}

function rec(id: string, projectPath?: string): StoredDeployment {
  return { id, project: id, network: 'mainnet', startedAt: 0, finishedAt: 0, jobIds: [], projectPath };
}

describe('DeploymentStore.hasProjectPath', () => {
  it('returns true only for a recorded projectPath', async () => {
    const store = new DeploymentStore(fakeMemento());
    await store.save(rec('a', '/home/user/proj-a'));
    await store.save(rec('b', '/home/user/proj-b'));

    expect(store.hasProjectPath('/home/user/proj-a')).toBe(true);
    expect(store.hasProjectPath('/home/user/proj-b')).toBe(true);
    expect(store.hasProjectPath('/home/user/.ssh')).toBe(false);
    expect(store.hasProjectPath('/etc/passwd')).toBe(false);
  });

  it('ignores records whose path info was removed', async () => {
    const store = new DeploymentStore(fakeMemento());
    await store.save(rec('a', '/home/user/proj-a'));
    await store.removePathInfo('a');
    expect(store.hasProjectPath('/home/user/proj-a')).toBe(false);
    // A record with no projectPath must not make an empty query "match".
    expect(store.hasProjectPath('')).toBe(false);
  });
});
