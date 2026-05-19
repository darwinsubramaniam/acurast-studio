import * as vscode from 'vscode';
import { AcurastContext } from '../context';
import { WalletService } from '../wallet/walletService';
import { StudioPanel } from '../studio/studioPanel';
import { newProject } from './newProject';
import { deploy } from './deploy';
import { estimateCost } from './estimateCost';
import { setActiveConfig, chooseConfig, clearActiveConfig } from './projectConfig';

export interface CommandDeps {
  ctx: AcurastContext;
  wallet: WalletService;
  output: vscode.OutputChannel;
  studioPanel: StudioPanel;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { ctx, wallet, output, studioPanel } = deps;
  return [
    vscode.commands.registerCommand('acurast.newProject', () => newProject(ctx)),
    vscode.commands.registerCommand('acurast.deploy', () => deploy({ ctx, wallet, output, studioPanel })),
    vscode.commands.registerCommand('acurast.estimateCost', () => estimateCost(ctx)),
    vscode.commands.registerCommand('acurast.openDashboard', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://console.acurast.com'));
    }),
    vscode.commands.registerCommand('acurast.setActiveConfig', (uri?: vscode.Uri) =>
      setActiveConfig(ctx, uri)
    ),
    vscode.commands.registerCommand('acurast.chooseConfig', () => chooseConfig(ctx)),
    vscode.commands.registerCommand('acurast.clearActiveConfig', () => clearActiveConfig(ctx)),
  ];
}
