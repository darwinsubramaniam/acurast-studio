import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factory below can reference them.
const { update, getInspect, setInspect } = vi.hoisted(() => {
  let inspectResult: Record<string, unknown> = {};
  return {
    update: vi.fn(),
    getInspect: () => inspectResult,
    setInspect: (v: Record<string, unknown>) => { inspectResult = v; },
  };
});

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, def: unknown) => def,
      inspect: () => getInspect(),
      update,
    }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));

// networkSetting imports loadAcurastConfig at module load; stub it out.
vi.mock('@acurast/sdk/deploy', () => ({ loadAcurastConfig: vi.fn(() => undefined) }));

import { setTargetNetwork } from '../../wallet/networkSetting';
import * as vscode from 'vscode';

beforeEach(() => {
  update.mockClear();
  setInspect({});
});

describe('setTargetNetwork', () => {
  it('writes to WorkspaceFolder when a folder-level override exists', async () => {
    setInspect({ workspaceFolderValue: 'mainnet' });
    await setTargetNetwork('canary');
    expect(update).toHaveBeenCalledWith('network', 'canary', vscode.ConfigurationTarget.WorkspaceFolder);
  });

  it('writes to Workspace when a workspace override exists', async () => {
    setInspect({ workspaceValue: 'mainnet' });
    await setTargetNetwork('canary');
    expect(update).toHaveBeenCalledWith('network', 'canary', vscode.ConfigurationTarget.Workspace);
  });

  it('writes to Global when no narrower scope is set', async () => {
    setInspect({});
    await setTargetNetwork('canary');
    expect(update).toHaveBeenCalledWith('network', 'canary', vscode.ConfigurationTarget.Global);
  });

  it('prefers WorkspaceFolder over Workspace when both are set', async () => {
    // Regression guard: a folder override must not be left shadowing a Global write.
    setInspect({ workspaceFolderValue: 'mainnet', workspaceValue: 'canary' });
    await setTargetNetwork('mainnet');
    expect(update).toHaveBeenCalledWith('network', 'mainnet', vscode.ConfigurationTarget.WorkspaceFolder);
  });
});
