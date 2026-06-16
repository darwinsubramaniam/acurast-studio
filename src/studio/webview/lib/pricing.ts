// Pure pricing-display helpers shared by the Deploy and Settings views. Kept
// here (not inlined per component) so the two cost panels can't drift.
import type { SerializedAdvice } from '../../types';

type AdviceStatus = SerializedAdvice['status'];

export interface AdviceVerdict {
  icon: string;
  label: string;
}

const ADVICE: Record<AdviceStatus, AdviceVerdict> = {
  sufficient: { icon: '✓', label: 'Sufficient' },
  overpaying: { icon: '⚠', label: 'Overpaying' },
  insufficient: { icon: '✗', label: 'Insufficient' },
};

/** Icon + human label for a market-pricing verdict, in one lookup. */
export function adviceVerdict(status: AdviceStatus): AdviceVerdict {
  return ADVICE[status];
}

/**
 * True when a job is insufficient *despite* the price already meeting the
 * suggested rate — i.e. the 0 matches come from a non-price requirement
 * (processor version, modules, attestation, reputation), not cost.
 */
export function isNonPriceBlocker(advice: SerializedAdvice): boolean {
  return (
    advice.status === 'insufficient' &&
    advice.suggestedPrice != null &&
    parseFloat(advice.currentPrice) >= parseFloat(advice.suggestedPrice)
  );
}
