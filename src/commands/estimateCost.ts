import * as vscode from 'vscode';
import { loadAcurastConfig } from '@acurast/sdk/deploy';
import { toCacu } from '@acurast/sdk/matcher';
import { BigNumber } from 'bignumber.js';
import { AcurastContext } from '../context';
import { WalletService } from '../wallet/walletService';
import { type AcurastNetwork, MATCHER_ENDPOINTS, SYMBOL } from '../sdk/constants';
import {
  loadPricing,
  satoshiToDisplay,
  type FeeAnalysis,
  type PricingResult,
} from '../sdk/pricing';
import type { AcurastProjectConfig } from '@acurast/sdk/types';

interface EstimateCostOptions {
  ctx: AcurastContext;
  wallet: WalletService;
  output: vscode.OutputChannel;
}

export async function estimateCost({ ctx, wallet, output }: EstimateCostOptions) {
  if (!ctx.configPath) {
    vscode.window.showErrorMessage('No active acurast.json. Choose one from the Acurast Studio sidebar.');
    return;
  }

  let config: AcurastProjectConfig;
  try {
    const loaded = loadAcurastConfig({ filePath: ctx.configPath });
    if (!loaded) {
      vscode.window.showErrorMessage('No project found in acurast.json.');
      return;
    }
    config = loaded;
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Failed to load acurast.json: ${(err as Error).message}`);
    return;
  }

  const network = (config.network ?? 'mainnet') as AcurastNetwork;
  const symbol = SYMBOL[network];

  const matcherOverrides = vscode.workspace.getConfiguration('acurast')
    .get<Record<string, string>>('matcherUrls', {});
  const matcherUrl = matcherOverrides[network] ?? MATCHER_ENDPOINTS[network];

  const activeWallet = await wallet.getActive();

  output.clear();
  output.show(true);
  output.appendLine(`[estimate-cost] project=${config.projectName} network=${network}`);
  output.appendLine('');
  output.appendLine('Fetching market pricing data...');

  const result = await loadPricing({
    config,
    walletAddress: activeWallet?.address,
    matcherUrl,
  });

  output.clear();
  output.appendLine(`[estimate-cost] project=${config.projectName} network=${network}`);
  output.appendLine('');

  renderToOutput(result, symbol, output);
}

function renderToOutput(result: PricingResult, symbol: string, output: vscode.OutputChannel) {
  const { fees, advice, fallbackReason, error } = result;

  if (fallbackReason) {
    const reasons: Record<typeof fallbackReason, string> = {
      'instant-match': 'Instant-match job — live market pricing skipped.',
      'no-wallet': 'No active wallet — live market pricing skipped.',
      'no-matcher-url': 'No matcher URL configured.',
      'matcher-error': `Matcher API error: ${error}. Falling back to static fee estimation.`,
      'matcher-unavailable': 'Matcher API unavailable or returned partial data. Falling back to static fee estimation.',
    };
    output.appendLine(`Note: ${reasons[fallbackReason]}`);
    output.appendLine('');
    renderStaticFees(fees, symbol, output);
    vscode.window.showInformationMessage(
      `${result.config.projectName}: max ${fees.maxCostPerExecutionCACU.toFixed(4)} ${symbol}/exec, total ${fees.maxTotalCostCACU.toFixed(4)} ${symbol}`
    );
    return;
  }

  if (!advice) return;

  output.appendLine('Processor pricing (live market data):');
  output.appendLine('');
  output.appendLine(`  Your max price:     ${satoshiToDisplay(advice.currentPrice)} ${symbol} per execution`);
  if (advice.averagePrice) {
    output.appendLine(`  Market average:     ${satoshiToDisplay(advice.averagePrice)} ${symbol} per execution`);
  }
  if (advice.suggestedPrice) {
    output.appendLine(`  Suggested price:    ${satoshiToDisplay(advice.suggestedPrice)} ${symbol} per execution`);
  }
  output.appendLine(`  Matched processors: ${advice.matchedProcessors} of ${advice.requiredProcessors} required`);
  output.appendLine('');

  if (advice.distribution.length > 0) {
    output.appendLine('  Price distribution (per execution):');
    const maxCount = Math.max(...advice.distribution.map((b) => b.count));
    const barWidth = 20;
    for (const bucket of advice.distribution) {
      const min = satoshiToDisplay(bucket.range_min);
      const max = satoshiToDisplay(bucket.range_max);
      const filled = maxCount > 0 ? Math.round((bucket.count / maxCount) * barWidth) : 0;
      const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
      const countStr = String(bucket.count).padStart(4);
      const bucketMin = new BigNumber(bucket.range_min);
      const bucketMax = new BigNumber(bucket.range_max);
      let marker = '';
      if (advice.currentPrice.gte(bucketMin) && advice.currentPrice.lt(bucketMax)) {
        marker = '  <- your price';
      } else if (advice.suggestedPrice && advice.suggestedPrice.gte(bucketMin) && advice.suggestedPrice.lt(bucketMax)) {
        marker = '  <- suggested';
      }
      output.appendLine(`    ${min.padStart(10)} - ${max.padEnd(10)} ${symbol}: ${bar} ${countStr} processors${marker}`);
    }
    output.appendLine('');
  }

  let toastSuffix: string;
  if (advice.status === 'insufficient') {
    const msg = advice.matchedProcessors === 0
      ? 'No processors available at your current price.'
      : `Not enough processors (${advice.matchedProcessors} of ${advice.requiredProcessors} required).`;
    output.appendLine(`[!] ${msg}`);
    if (advice.suggestedPrice) {
      output.appendLine(`    Suggested price: ${satoshiToDisplay(advice.suggestedPrice)} ${symbol} (covers ${advice.requiredProcessors} processors)`);
    }
    output.appendLine('');
    toastSuffix = ` | INSUFFICIENT — ${advice.matchedProcessors}/${advice.requiredProcessors} matched`;
  } else if (advice.status === 'overpaying') {
    output.appendLine(`[!] Your price is above what is needed to match ${advice.requiredProcessors} processors.`);
    if (advice.suggestedPrice) {
      const savings = advice.currentPrice.minus(advice.suggestedPrice);
      output.appendLine(`    You could save ${satoshiToDisplay(savings)} ${symbol}/exec by lowering to ${satoshiToDisplay(advice.suggestedPrice)} ${symbol}.`);
    }
    output.appendLine('');
    toastSuffix = ` | overpaying — ${advice.matchedProcessors}/${advice.requiredProcessors} matched`;
  } else {
    output.appendLine(`[ok] Your price matches ${advice.matchedProcessors} processors (${advice.requiredProcessors} required).`);
    output.appendLine('');
    toastSuffix = ` | ${advice.matchedProcessors}/${advice.requiredProcessors} processors matched`;
  }

  vscode.window.showInformationMessage(
    `${result.config.projectName}: ${satoshiToDisplay(advice.currentPrice)} ${symbol}/exec${toastSuffix}`
  );
}

function renderStaticFees(fees: FeeAnalysis, symbol: string, output: vscode.OutputChannel) {
  const suggestedCacu = toCacu(fees.suggestedCostPerExecution);
  const maxCacu = toCacu(fees.maxCostPerExecution);
  const excessCacu = toCacu(fees.excessCostPerExecution);

  if (fees.excessCostPerExecution.lt(0)) {
    output.appendLine('[!] "maxCostPerExecution" is below the suggested fee — deployment may not get matched!');
    output.appendLine(`    Suggested: ${suggestedCacu.toFixed()} ${symbol}, yours: ${maxCacu.toFixed()} ${symbol}, shortfall: ${excessCacu.abs().toFixed()} ${symbol}`);
    output.appendLine('');
  } else if (fees.excessCostPerExecutionPercentage.gt(0.1)) {
    output.appendLine(`[!] "maxCostPerExecution" is ${fees.excessCostPerExecutionPercentage.multipliedBy(100).toFixed(0)}% above the suggested fee — you may be overpaying.`);
    output.appendLine(`    Suggested: ${suggestedCacu.toFixed()} ${symbol}, yours: ${maxCacu.toFixed()} ${symbol}, excess: ${excessCacu.toFixed()} ${symbol}`);
    output.appendLine('');
  }

  output.appendLine(`  Executions:           ${fees.numberOfExecutions}`);
  output.appendLine(`  Replicas:             ${fees.numberOfReplicas}`);
  output.appendLine(`  Total runs:           ${fees.totalRuns}`);
  output.appendLine(`  Max cost/exec:        ${fees.maxCostPerExecutionCACU.toFixed()} ${symbol}`);
  output.appendLine(`  Cost/exec/replica:    ${fees.maxCostPerExecutionPerReplicaCACU.toFixed()} ${symbol}`);
  output.appendLine(`  Suggested cost/exec:  ${suggestedCacu.toFixed()} ${symbol}`);
  output.appendLine(`  Max total cost:       ${fees.maxTotalCostCACU.toFixed()} ${symbol}`);
  output.appendLine('');
}
