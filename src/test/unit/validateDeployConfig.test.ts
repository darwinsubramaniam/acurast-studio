import { describe, it, expect } from 'vitest';
import { validateDeployConfig, formatIssue } from '../../sdk/validateDeployConfig';

// A minimal but schema-valid project config, mirroring fixtures/demo-workspace/acurast.json.
// It omits `runtime`, so the SDK defaults it to NodeJS. Individual tests spread
// over this to introduce one problem at a time. The Shell runtime (which requires
// an `image`) is covered separately below.
const validConfig = {
  projectName: 'demo',
  fileUrl: 'index.js',
  network: 'mainnet',
  onlyAttestedDevices: true,
  assignmentStrategy: { type: 'Single' },
  execution: { type: 'onetime', maxExecutionTimeInMs: 300000 },
  maxAllowedStartDelayInMs: 10000,
  usageLimit: { maxMemory: 0, maxNetworkRequests: 0, maxStorage: 0 },
  numberOfReplicas: 1,
  requiredModules: [],
  minProcessorReputation: 0,
  maxCostPerExecution: 100000000000,
  includeEnvironmentVariables: [],
  processorWhitelist: [],
};

const messages = (issues: { message: string }[]) => issues.map((i) => i.message);

describe('validateDeployConfig', () => {
  it('passes a valid config (default NodeJS runtime) with no errors and no notes', () => {
    const { errors, notes } = validateDeployConfig(validConfig);
    expect(errors).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('passes a valid Shell-runtime config (runtime + image) with no errors and no notes', () => {
    const { errors, notes } = validateDeployConfig({
      ...validConfig,
      runtime: 'Shell',
      image: { url: 'https://easycli.sh/rootfs.tar.xz', sha256: 'a'.repeat(64) },
    });
    expect(errors).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('reports a missing required field as a blocking error', () => {
    const { maxCostPerExecution, ...withoutCost } = validConfig;
    void maxCostPerExecution;
    const { errors } = validateDeployConfig(withoutCost);
    expect(errors.some((e) => e.path === 'maxCostPerExecution')).toBe(true);
  });

  it('blocks when instantMatch count does not equal numberOfReplicas', () => {
    const { errors } = validateDeployConfig({
      ...validConfig,
      numberOfReplicas: 2,
      assignmentStrategy: {
        type: 'Single',
        instantMatch: [{ processor: '5abc', maxAllowedStartDelayInMs: 1000 }],
      },
    });
    expect(messages(errors).join(' ')).toMatch(/instantMatch entries must equal numberOfReplicas/);
  });

  it('flags a Shell runtime with no image as an advisory note, not an error', () => {
    const { errors, notes } = validateDeployConfig({ ...validConfig, runtime: 'Shell' });
    expect(errors).toEqual([]);
    expect(notes.some((n) => n.path === 'image' && /image is required/i.test(n.message))).toBe(true);
  });

  it('warns when onlyAttestedDevices is false (non-blocking)', () => {
    const { errors, notes } = validateDeployConfig({ ...validConfig, onlyAttestedDevices: false });
    expect(errors).toEqual([]);
    expect(notes.some((n) => n.path === 'onlyAttestedDevices')).toBe(true);
  });

  it('warns when the start time is under the safe window (non-blocking)', () => {
    const { errors, notes } = validateDeployConfig({ ...validConfig, startAt: { msFromNow: 60000 } });
    expect(errors).toEqual([]);
    expect(notes.some((n) => /less than 5 minutes/i.test(n.message))).toBe(true);
  });

  it('does not duplicate a hard error into the advisory notes', () => {
    // A config that both fails a hard rule AND would trip note-level checks: the
    // hard error must appear only in `errors`, never leak into `notes`.
    const { errors, notes } = validateDeployConfig({
      ...validConfig,
      numberOfReplicas: 2,
      onlyAttestedDevices: false,
      assignmentStrategy: {
        type: 'Single',
        instantMatch: [{ processor: '5abc', maxAllowedStartDelayInMs: 1000 }],
      },
    });
    const errKeys = new Set(errors.map((e) => `${e.path} ${e.message}`));
    expect(notes.every((n) => !errKeys.has(`${n.path} ${n.message}`))).toBe(true);
    // the advisory (onlyAttestedDevices) still comes through despite the hard error
    expect(notes.some((n) => n.path === 'onlyAttestedDevices')).toBe(true);
  });

  it('formatIssue renders "path: message", or bare message at the root', () => {
    expect(formatIssue({ path: 'image', message: 'required' })).toBe('image: required');
    expect(formatIssue({ path: '', message: 'top-level problem' })).toBe('top-level problem');
  });
});
