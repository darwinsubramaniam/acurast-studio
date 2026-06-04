import { fetchPricingAdvice, getFeeAnalysis } from '@acurast/sdk/matcher';
import { AssignmentStrategyVariant } from '@acurast/sdk/types';
import type { AcurastProjectConfig } from '@acurast/sdk/types';
import type { PricingAdvice } from '@acurast/sdk/matcher';
import { BigNumber } from 'bignumber.js';
import { normalizeMinProcessorVersions } from './configCompat';

export type { PricingAdvice };
export type FeeAnalysis = ReturnType<typeof getFeeAnalysis>;

export type PricingFallbackReason =
  | 'instant-match'
  | 'targeted'
  | 'no-wallet'
  | 'no-matcher-url'
  | 'matcher-error'
  | 'matcher-unavailable';

export interface PricingResult {
  config: AcurastProjectConfig;
  fees: FeeAnalysis;
  advice?: PricingAdvice;
  fallbackReason?: PricingFallbackReason;
  error?: string;
}

export interface LoadPricingOptions {
  config: AcurastProjectConfig;
  walletAddress?: string;
  matcherUrl?: string;
}

export async function loadPricing({
  config: rawConfig,
  walletAddress,
  matcherUrl,
}: LoadPricingOptions): Promise<PricingResult> {
  // Coerce quoted numeric min-versions (e.g. "122") to numbers so the SDK's
  // job conversion doesn't throw — see normalizeMinProcessorVersions.
  const config = normalizeMinProcessorVersions(rawConfig);
  const fees = getFeeAnalysis(config);

  const hasInstantMatch =
    config.assignmentStrategy.type === AssignmentStrategyVariant.Single &&
    Array.isArray((config.assignmentStrategy as any).instantMatch) &&
    (config.assignmentStrategy as any).instantMatch.length > 0;

  if (hasInstantMatch) {
    return { config, fees, fallbackReason: 'instant-match' };
  }
  // A processor whitelist targets specific devices. The matcher `check` RPC
  // ignores `processorWhitelist`, so its matched-count would describe the open
  // market, not your targeted processors — making it misleading. Skip it.
  if (Array.isArray(config.processorWhitelist) && config.processorWhitelist.length > 0) {
    return { config, fees, fallbackReason: 'targeted' };
  }
  if (!walletAddress) {
    return { config, fees, fallbackReason: 'no-wallet' };
  }
  if (!matcherUrl) {
    return { config, fees, fallbackReason: 'no-matcher-url' };
  }

  try {
    const advice = await fetchPricingAdvice(config, walletAddress, matcherUrl);
    if (!advice) {
      return { config, fees, fallbackReason: 'matcher-unavailable' };
    }
    return { config, fees, advice };
  } catch (err: unknown) {
    return { config, fees, fallbackReason: 'matcher-error', error: (err as Error).message };
  }
}

export const ACURAST_DECIMALS = 12;

export function satoshiToDisplay(satoshi: BigNumber | string): string {
  return new BigNumber(satoshi).shiftedBy(-ACURAST_DECIMALS).toFixed();
}
