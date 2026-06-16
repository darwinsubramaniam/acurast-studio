// Pure presentation logic for the Tunnel DNS wizard, extracted from the view so
// the status-pill ladder, the per-record badges and the stepper state are unit
// testable in isolation (no DOM, no Svelte). The component derives the inputs
// and feeds them in; these functions own the wording and tone mapping.

export type PillTone = 'draft' | 'pending' | 'progress' | 'warn' | 'live' | 'error';
export interface StatusPill {
  label: string;
  tone: PillTone;
}

export type BadgeCls = 'ok' | 'miss' | 'pending';
export interface Badge {
  label: string;
  cls: BadgeCls;
}

export type StepUiState = 'done' | 'active' | 'todo';

export interface StatusInputs {
  /** The host's last DNS verification status for this suffix/network. */
  verifyStatus: 'idle' | 'checking' | 'done' | 'error';
  /** Both the wildcard A record and the TXT proof resolved. */
  bothVerified: boolean;
  /** How many of the two records (wildcard, TXT) currently verify. */
  verifiedCount: number;
  hasSuffix: boolean;
  hasRelays: boolean;
  hasWallet: boolean;
  /** Wizard step the user is on (1 Configure · 2 Records · 3 Verify). */
  step: number;
  /** Display label for the active network, e.g. "Canary"/"Mainnet". */
  netLabel: string;
}

/**
 * The single status pill shown in the served-at banner. Verify outcomes take
 * precedence (error → checking → done), then the step-2 blocking edge states
 * (no relays / no wallet), then the plain progress labels.
 */
export function statusPill(i: StatusInputs): StatusPill {
  if (i.verifyStatus === 'error') return { label: 'Verification error', tone: 'error' };
  if (i.verifyStatus === 'checking') return { label: 'Verifying… · querying DNS resolvers', tone: 'progress' };
  if (i.verifyStatus === 'done') {
    if (i.bothVerified) return { label: 'Live · verified', tone: 'live' };
    return { label: `Partially verified · ${i.verifiedCount} of 2 records`, tone: 'warn' };
  }
  if (!i.hasSuffix) return { label: 'Draft · records not generated', tone: 'draft' };
  if (i.step >= 2 && !i.hasRelays) return { label: `Blocked · no relays for ${i.netLabel}`, tone: 'error' };
  if (i.step >= 2 && !i.hasWallet) return { label: 'Action needed · no wallet to sign with', tone: 'warn' };
  if (i.step >= 2) return { label: 'Records ready · awaiting DNS verification', tone: 'pending' };
  return { label: 'Draft · records not generated', tone: 'draft' };
}

/**
 * Badge for a single record card. Before a verify completes it shows the
 * pre-verify default; after, it reflects whether that record resolved.
 */
export function recordBadge(
  verifyDone: boolean,
  ok: boolean,
  opts: { missLabel: string; defaultLabel: string; defaultCls: BadgeCls },
): Badge {
  if (verifyDone) return ok ? { label: 'verified', cls: 'ok' } : { label: opts.missLabel, cls: 'miss' };
  return { label: opts.defaultLabel, cls: opts.defaultCls };
}

export const wildcardBadge = (verifyDone: boolean, ok: boolean): Badge =>
  recordBadge(verifyDone, ok, { missLabel: 'not found', defaultLabel: 'pending', defaultCls: 'pending' });

export const txtBadge = (verifyDone: boolean, ok: boolean): Badge =>
  recordBadge(verifyDone, ok, { missLabel: 'missing', defaultLabel: 'missing', defaultCls: 'miss' });

/** Stepper cell state for step `n` given the current `step` and the live verdict. */
export function stepUiState(step: number, n: 1 | 2 | 3, bothVerified: boolean): StepUiState {
  if (n === 1) return step > 1 ? 'done' : step === 1 ? 'active' : 'todo';
  if (n === 2) return step > 2 ? 'done' : step === 2 ? 'active' : 'todo';
  return bothVerified ? 'done' : step === 3 ? 'active' : 'todo';
}
