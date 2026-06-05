import * as vscode from 'vscode';
import { loadAcurastConfig } from '@acurast/sdk/deploy';

/** The Studio target network (the `acurast.network` setting), defaulting to mainnet. */
export function getTargetNetwork(): string {
  return vscode.workspace.getConfiguration('acurast').get<string>('network', 'mainnet');
}

/**
 * Network the acurast.json at `configPath` deploys to, or undefined when no
 * project is active or its config can't be read/parsed. Single source for the
 * `loadAcurastConfig(...).network ?? 'mainnet'` read shared by the status bar
 * and the studio panel.
 */
export function getProjectNetwork(configPath: string | undefined): string | undefined {
  if (!configPath) return undefined;
  try {
    return loadAcurastConfig({ filePath: configPath })?.network ?? 'mainnet';
  } catch {
    return undefined;
  }
}

/**
 * Persist the Studio target network. Writes to whichever scope already defines
 * the setting — folder override → workspace → global user — so a narrower
 * existing value isn't left silently shadowing the write (which would make the
 * switch a no-op and leave the mismatch warning stuck on).
 */
export async function setTargetNetwork(network: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('acurast');
  const inspected = cfg.inspect<string>('network');
  const target =
    inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await cfg.update('network', network, target);
}
