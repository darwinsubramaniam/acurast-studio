import { describe, it, expect } from 'vitest';
import {
  isExpired,
  deriveJobRequirements,
  buildJobChecks,
  buildProcessorChecks,
  computeSummary,
} from '../../lib/diagnosis';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

describe('isExpired', () => {
  it('treats endTime 0 (no end recorded) as not expired', () => {
    expect(isExpired(0, NOW)).toBe(false);
  });
  it('is expired once endTime has passed', () => {
    expect(isExpired(NOW - 1, NOW)).toBe(true);
  });
  it('is not expired while endTime is in the future', () => {
    expect(isExpired(NOW + 1, NOW)).toBe(false);
  });
});

describe('deriveJobRequirements', () => {
  it('flattens schedule + extra.requirements and detects instant match', () => {
    const reg = {
      schedule: { startTime: 1000, maxStartDelay: 60_000, duration: 30_000, endTime: 5000 },
      requiredModules: ['DataEncryption'],
      allowedSources: ['5Proc'],
      storage: 10,
      memory: 20,
      extra: {
        requirements: {
          reward: '12345',
          minReputation: 50,
          processorVersion: { min: [{ platform: 0, buildNumber: 70 }] },
          assignmentStrategy: { single: [{ processor: '5Proc', maxAllowedStartDelayInMs: 1000 }] },
        },
      },
    };
    const r = deriveJobRequirements(reg);
    expect(r.startTime).toBe(1000);
    expect(r.endTime).toBe(5000);
    expect(r.reqModules).toEqual(['DataEncryption']);
    expect(r.allowed).toEqual(['5Proc']);
    expect(r.reward).toBe(12345n);
    expect(r.minRep).toBe(50);
    expect(r.isInstant).toBe(true);
    expect(r.isCompeting).toBe(false);
  });

  it('detects competing strategy and missing requirements', () => {
    const r = deriveJobRequirements({
      schedule: {},
      extra: { requirements: { assignmentStrategy: { competing: null } } },
    });
    expect(r.isCompeting).toBe(true);
    expect(r.isInstant).toBe(false);
    expect(r.reward).toBe(0n);
    expect(r.minRep).toBeNull();
    expect(r.allowed).toEqual([]);
  });
});

describe('buildJobChecks', () => {
  const base = {
    jobStatus: 'open' as const,
    expired: false,
    now: NOW,
    startTime: NOW,
    maxStartDelay: 60_000,
    endTime: 0,
    isInstant: false,
    isCompeting: false,
    allowed: ['5Proc'],
  };

  it('leads with a lifecycle warning when expired', () => {
    const checks = buildJobChecks({ ...base, expired: true, endTime: NOW - HOUR });
    expect(checks[0].id).toBe('lifecycle');
    expect(checks[0].status).toBe('warn');
    const sw = checks.find((c) => c.id === 'startWindow');
    expect(sw?.status).toBe('info'); // window long closed, not a fresh fail
  });

  it('marks the start window pass when still open', () => {
    const checks = buildJobChecks(base);
    expect(checks.find((c) => c.id === 'startWindow')?.status).toBe('pass');
  });

  it('marks the start window fail once it has closed', () => {
    const checks = buildJobChecks({ ...base, startTime: NOW - 120_000 });
    expect(checks.find((c) => c.id === 'startWindow')?.status).toBe('fail');
  });

  it('passes the start window when already assigned', () => {
    const checks = buildJobChecks({ ...base, jobStatus: 'assigned', startTime: NOW - 120_000 });
    expect(checks.find((c) => c.id === 'startWindow')?.status).toBe('pass');
  });

  it('adds a public whitelist note only when there are no allowed sources', () => {
    expect(buildJobChecks(base).find((c) => c.id === 'whitelist')).toBeUndefined();
    expect(buildJobChecks({ ...base, allowed: [] }).find((c) => c.id === 'whitelist')).toBeDefined();
  });
});

describe('buildProcessorChecks', () => {
  const base = {
    address: '5Proc',
    now: NOW,
    reqModules: ['DataEncryption'],
    origin: '5Deployer',
    duration: 1000,
    storage: 10,
    memory: 20,
    reward: 1000n,
    minVer: [] as any[],
    minRep: null as number | null,
    price: null,
    ver: null,
    rep: null,
    hb: NOW - 1000,
  };

  it('fails fast when the processor has no advertisement', () => {
    const d = buildProcessorChecks({ ...base, restr: null });
    expect(d.eligible).toBe(false);
    expect(d.checks).toHaveLength(1);
    expect(d.checks[0].id).toBe('ad');
  });

  it('is eligible when every hard gate passes', () => {
    const d = buildProcessorChecks({
      ...base,
      restr: { availableModules: ['DataEncryption'], allowedConsumers: [], maxMemory: 100, storageCapacity: 100 },
      price: { baseFeePerExecution: '1', feePerMillisecond: '0', feePerStorageByte: '0' },
    });
    expect(d.eligible).toBe(true);
    expect(d.checks.find((c) => c.id === 'modules')?.status).toBe('pass');
    expect(d.checks.find((c) => c.id === 'fee')?.status).toBe('pass');
  });

  it('fails on a missing required module', () => {
    const d = buildProcessorChecks({
      ...base,
      restr: { availableModules: [], allowedConsumers: [] },
    });
    expect(d.eligible).toBe(false);
    expect(d.checks.find((c) => c.id === 'modules')?.status).toBe('fail');
  });

  it('fails when the advertised fee exceeds the reward', () => {
    const d = buildProcessorChecks({
      ...base,
      restr: { availableModules: ['DataEncryption'], allowedConsumers: [] },
      price: { baseFeePerExecution: '999999', feePerMillisecond: '0', feePerStorageByte: '0' },
    });
    expect(d.eligible).toBe(false);
    expect(d.checks.find((c) => c.id === 'fee')?.status).toBe('fail');
  });

  it('fails a private ad when the deployer is not an allowed consumer', () => {
    const d = buildProcessorChecks({
      ...base,
      restr: { availableModules: ['DataEncryption'], allowedConsumers: [{ acurast: '5Someone' }] },
    });
    expect(d.eligible).toBe(false);
    expect(d.checks.find((c) => c.id === 'consumers')?.status).toBe('fail');
  });
});

describe('computeSummary', () => {
  const base = {
    jobStatus: 'open' as const,
    expired: false,
    now: NOW,
    endTime: 0,
    assignedSlots: undefined as number | undefined,
    allowed: ['5Proc'],
    processors: [{ address: '5Proc', eligible: true, checks: [] }],
    startClosed: false,
  };

  it('leads with expiry even when the job had been assigned', () => {
    const s = computeSummary({ ...base, expired: true, endTime: NOW - HOUR, jobStatus: 'assigned', assignedSlots: 2 });
    expect(s).toMatch(/^Expired/);
    expect(s).toContain('2 slot');
  });

  it('reports a match when assigned and not expired', () => {
    expect(computeSummary({ ...base, jobStatus: 'assigned', assignedSlots: 1 })).toMatch(/^Matched/);
  });

  it('reports no eligible processor when all whitelisted ones fail', () => {
    const s = computeSummary({ ...base, processors: [{ address: '5Proc', eligible: false, checks: [] }] });
    expect(s).toContain('no whitelisted processor');
  });

  it('reports a closed start window', () => {
    const s = computeSummary({ ...base, startClosed: true, processors: [{ address: '5Proc', eligible: true, checks: [] }] });
    expect(s).toContain('start window has closed');
  });

  it('reports a public job waiting on the matcher', () => {
    const s = computeSummary({ ...base, allowed: [], processors: [] });
    expect(s).toContain('public job');
  });
});
