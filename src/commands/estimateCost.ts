import * as vscode from 'vscode';
import { AcurastContext } from '../context';

const ACU_TO_USD = 0.012; // placeholder; replace with live price fetch

export async function estimateCost(ctx: AcurastContext) {
  const config = ctx.config;
  if (!config) {
    vscode.window.showErrorMessage('Could not read acurast.json.');
    return;
  }

  const maxCostStr = config.maxCostPerExecution ?? '0';
  const maxCostAcu = parseFloat(maxCostStr) / 1e12; // planck → ACU
  const replicas = config.maxReplicas ?? 1;

  const executions = await vscode.window.showInputBox({
    prompt: 'How many total executions?',
    value: '100',
    validateInput: (v) => (isNaN(Number(v)) ? 'Must be a number' : undefined),
  });
  if (!executions) return;

  const totalAcu = maxCostAcu * replicas * Number(executions);
  const totalUsd = totalAcu * ACU_TO_USD;

  vscode.window.showInformationMessage(
    `Estimated cost: ${totalAcu.toFixed(4)} ACU (~$${totalUsd.toFixed(2)} USD)\n` +
    `Based on ${replicas} replica(s) × ${executions} executions × ${maxCostAcu.toFixed(6)} ACU/exec`,
    { modal: true }
  );
}
