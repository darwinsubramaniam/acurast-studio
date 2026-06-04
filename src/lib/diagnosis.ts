// Pure decision logic for on-chain job diagnosis.
//
// Everything here is a pure function: inputs are plain JS objects already read
// from chain (no `api`, no `await`, no `vscode`), outputs are DiagnosisChecks /
// summary strings. The I/O — the Substrate `api.query.*` lookups — lives in
// `src/sdk/acurastClient.ts`, which decodes the chain values and delegates the
// reasoning here so it can be unit-tested in isolation.

import { getHumanReadableVersion } from '@acurast/sdk/chain';
import type { DiagnosisCheck, ProcessorDiagnosis } from '../studio/types';
import { fmtAgo } from './duration';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A deployment has expired once its schedule end has passed. Mirrors the
 * lifecycle rule the History view uses (`History.svelte`: `endTime < now`).
 * `endTime === 0` means "no end recorded", which we treat as not-expired.
 */
export function isExpired(endTime: number, now: number): boolean {
  return endTime > 0 && endTime < now;
}

export interface JobRequirements {
  startTime: number;
  maxStartDelay: number;
  duration: number;
  endTime: number;
  reqModules: string[];
  allowed: string[];
  reward: bigint;
  storage: number;
  memory: number;
  minRep: number | null;
  minVer: any[];
  isInstant: boolean;
  isCompeting: boolean;
}

/** Decode a JobRegistration into the flat set of values the checks need. */
export function deriveJobRequirements(reg: any): JobRequirements {
  const sched = reg.schedule ?? {};
  const reqs = reg.extra?.requirements ?? {};
  const strat = reqs.assignmentStrategy ?? {};
  const isCompeting = strat.competing !== undefined;
  const isInstant = !isCompeting && Array.isArray(strat.single) && strat.single.length > 0;
  return {
    startTime: Number(sched.startTime ?? 0),
    maxStartDelay: Number(sched.maxStartDelay ?? 0),
    duration: Number(sched.duration ?? 0),
    endTime: Number(sched.endTime ?? 0),
    reqModules: (reg.requiredModules ?? []).map((m: any) => String(m)),
    allowed: (reg.allowedSources ?? []).map((s: any) => String(s)),
    reward: BigInt(reqs.reward ?? 0),
    storage: Number(reg.storage ?? 0),
    memory: Number(reg.memory ?? 0),
    minRep: reqs.minReputation != null ? Number(reqs.minReputation) : null,
    minVer: reqs.processorVersion?.min ?? [],
    isInstant,
    isCompeting,
  };
}

export interface JobChecksInput {
  jobStatus: 'open' | 'assigned' | 'unknown';
  expired: boolean;
  now: number;
  startTime: number;
  maxStartDelay: number;
  endTime: number;
  isInstant: boolean;
  isCompeting: boolean;
  allowed: string[];
}

/** Job-level checks: lifecycle (expiry), start window, assignment strategy, whitelist. */
export function buildJobChecks(input: JobChecksInput): DiagnosisCheck[] {
  const { jobStatus, expired, now, startTime, maxStartDelay, endTime, isInstant, isCompeting, allowed } = input;
  const checks: DiagnosisCheck[] = [];
  const windowEnd = startTime + maxStartDelay;

  // Lifecycle first, so an expired deployment leads with that fact instead of
  // reading as a currently-healthy assignment.
  if (expired) {
    checks.push({
      id: 'lifecycle', label: 'Schedule', status: 'warn',
      detail: `Deployment ended ${fmtAgo(now - endTime)} — it has expired and is no longer active. Redeploy to run again.`,
    });
  }

  if (expired) {
    checks.push({ id: 'startWindow', label: 'Start window', status: 'info', detail: 'Start window long closed — the deployment has already ended.' });
  } else if (jobStatus === 'assigned') {
    checks.push({ id: 'startWindow', label: 'Start window', status: 'pass', detail: 'Job is already assigned.' });
  } else if (now <= windowEnd) {
    checks.push({ id: 'startWindow', label: 'Start window', status: 'pass', detail: `Open for ~${Math.round((windowEnd - now) / 1000)}s more (until startTime + maxStartDelay).` });
  } else {
    checks.push({ id: 'startWindow', label: 'Start window', status: 'fail', detail: `Closed ${Math.round((now - windowEnd) / 1000)}s ago. A job can't be assigned past startTime + maxStartDelay — increase Max start delay and redeploy.` });
  }

  checks.push({
    id: 'assignment', label: 'Assignment', status: 'info',
    detail: isInstant ? 'Instant match — targets specific processor(s) directly (fastest).'
      : isCompeting ? 'Competing — new processors per execution via the open matcher.'
      : 'Single, open matcher — relies on the network matcher within the start window. Use Instant Match to target a known processor.',
  });

  if (!allowed.length) {
    checks.push({ id: 'whitelist', label: 'Whitelist', status: 'info', detail: 'Public job (no processor whitelist) — eligibility can only be checked against specific processors.' });
  }

  return checks;
}

export interface ProcessorChecksInput {
  address: string;
  restr: any;
  price: any;
  ver: any;
  rep: any;
  hb: number | null;
  now: number;
  reqModules: string[];
  origin: string;
  duration: number;
  storage: number;
  memory: number;
  reward: bigint;
  minVer: any[];
  minRep: number | null;
}

/** Evaluate a single whitelisted processor against every hard gate. */
export function buildProcessorChecks(input: ProcessorChecksInput): ProcessorDiagnosis {
  const { address, restr, price, ver, rep, hb, now, reqModules, origin, duration, storage, memory, reward, minVer, minRep } = input;

  if (!restr) {
    return {
      address, eligible: false,
      checks: [{ id: 'ad', label: 'Advertisement', status: 'fail', detail: 'No marketplace advertisement — this processor is not advertising and cannot match anything.' }],
    };
  }

  const checks: DiagnosisCheck[] = [];
  const avail: string[] = (restr.availableModules ?? []).map((m: any) => String(m));
  const consumers: string[] = (restr.allowedConsumers ?? []).map((c: any) => typeof c === 'string' ? c : (c?.acurast ?? c?.Acurast ?? JSON.stringify(c)));

  const modulesOk = reqModules.every((m) => avail.includes(m));
  checks.push({ id: 'modules', label: 'Modules', status: modulesOk ? 'pass' : 'fail', detail: `requires [${reqModules.join(', ') || '—'}], advertises [${avail.join(', ') || '—'}]` });

  const privateOk = !consumers.length || consumers.includes(origin);
  checks.push({ id: 'consumers', label: 'Consumer access', status: privateOk ? 'pass' : 'fail', detail: consumers.length ? (privateOk ? 'deployer is in the processor\'s allowedConsumers (private ad).' : 'private ad — deployer is NOT in allowedConsumers.') : 'public ad — open to any consumer.' });

  let feeOk = true;
  if (price) {
    const fee = BigInt(price.baseFeePerExecution ?? 0) + BigInt(price.feePerMillisecond ?? 0) * BigInt(duration) + BigInt(price.feePerStorageByte ?? 0) * BigInt(storage);
    feeOk = fee <= reward;
    checks.push({ id: 'fee', label: 'Fee vs reward', status: feeOk ? 'pass' : 'fail', detail: `ad fee ${fee} planck ${feeOk ? '≤' : '>'} reward ${reward} planck (base + perMs×duration + perByte×storage). ${feeOk ? '' : 'Raise Max cost per execution.'}`.trim() });
  } else {
    checks.push({ id: 'fee', label: 'Fee vs reward', status: 'info', detail: 'processor has no pricing entry.' });
  }

  let versionOk = true;
  if (minVer.length) {
    const m = minVer.find((x: any) => Number(x.platform) === Number(ver?.platform)) ?? minVer[0];
    versionOk = ver != null && Number(ver.buildNumber) >= Number(m.buildNumber);
    const human = ver ? getHumanReadableVersion(ver) : '?';
    checks.push({ id: 'version', label: 'Version', status: versionOk ? 'pass' : 'fail', detail: `processor build ${ver?.buildNumber ?? '?'} (${human}) ${versionOk ? '≥' : '<'} min build ${m.buildNumber}` });
  } else {
    checks.push({ id: 'version', label: 'Version', status: 'info', detail: `processor build ${ver?.buildNumber ?? '?'} — no minimum required.` });
  }

  if (minRep != null) {
    checks.push({ id: 'reputation', label: 'Reputation', status: 'warn', detail: `min reputation ${minRep} required; processor r/s = ${rep?.r ?? 0}/${rep?.s ?? 0} (verify on the matcher).` });
  }

  const resOk = (restr.maxMemory == null || memory <= Number(restr.maxMemory)) && (restr.storageCapacity == null || storage <= Number(restr.storageCapacity));
  checks.push({ id: 'resources', label: 'Resources', status: resOk ? 'pass' : 'fail', detail: `job memory ${memory}/${restr.maxMemory ?? '∞'}, storage ${storage}/${restr.storageCapacity ?? '∞'}` });

  if (hb != null) {
    const ageS = Math.round((now - hb) / 1000);
    checks.push({ id: 'heartbeat', label: 'Liveness', status: ageS < 600 ? 'pass' : 'warn', detail: `last heartbeat ${ageS}s ago${ageS < 600 ? ' (online)' : ' — processor may be offline; it must be online during the start window'}.` });
  } else {
    checks.push({ id: 'heartbeat', label: 'Liveness', status: 'warn', detail: 'no heartbeat recorded — processor may never have come online.' });
  }

  const eligible = modulesOk && privateOk && feeOk && versionOk && resOk;
  return { address, eligible, checks };
}

export interface SummaryInput {
  jobStatus: 'open' | 'assigned' | 'unknown';
  expired: boolean;
  now: number;
  endTime: number;
  assignedSlots?: number;
  allowed: string[];
  processors: ProcessorDiagnosis[];
  startClosed: boolean;
}

/** One-line overall verdict. Expiry takes precedence over the match status. */
export function computeSummary(input: SummaryInput): string {
  const { jobStatus, expired, now, endTime, assignedSlots, allowed, processors, startClosed } = input;
  const eligibleCount = processors.filter((p) => p.eligible).length;

  if (expired) {
    return `Expired — schedule ended ${fmtAgo(now - endTime)}`
      + (assignedSlots != null ? ` (had been assigned to ${assignedSlots} slot(s))` : '')
      + '. Redeploy to run again.';
  }
  if (jobStatus === 'assigned') {
    return `Matched ✓${assignedSlots != null ? ` — assigned to ${assignedSlots} slot(s)` : ''}.`;
  }
  if (allowed.length && eligibleCount === 0) {
    return 'Unmatched — no whitelisted processor passes every requirement. Fix the failed checks below.';
  }
  if (startClosed) {
    return 'Unmatched — the start window has closed; the job can no longer be assigned. Widen Max start delay and redeploy.';
  }
  if (!allowed.length) {
    return 'Unmatched — public job waiting on the open matcher. Whitelist a processor (or use Instant Match) to diagnose eligibility.';
  }
  return 'Eligible but unmatched — the matcher likely hasn\'t assigned it yet. Use Instant Match and a wider start window to improve odds.';
}
