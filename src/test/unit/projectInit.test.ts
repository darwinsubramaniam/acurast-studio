import { describe, it, expect } from 'vitest';
import {
  buildProjectEntry,
  buildScaffold,
  parseDurationMs,
  type InitOptions,
} from '../../lib/projectInit';

const ONETIME = { type: 'onetime', maxExecutionTimeInMs: 600_000 } as const;

const nodeOpts: InitOptions = {
  name: 'my-tunnel-app',
  runtime: 'NodeJS',
  network: 'mainnet',
  execution: ONETIME,
};

const shellOpts: InitOptions = {
  name: 'cargo-tunnel',
  runtime: 'Shell',
  network: 'mainnet',
  execution: ONETIME,
  image: {
    url: 'https://github.com/termux/proot-distro/releases/download/v4.30.1/ubuntu-questing-aarch64-pd-v4.30.1.tar.xz',
    sha256: '5ab35b90cd9a9f180656261ba400a135c4c01c2da4b74522118342f985c2d328',
  },
};

describe('parseDurationMs', () => {
  it('parses single units', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('10min')).toBe(600_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(parseDurationMs('1d')).toBe(86_400_000);
    expect(parseDurationMs('500ms')).toBe(500);
  });

  it('tolerates spaces and compound spans', () => {
    expect(parseDurationMs('10 min')).toBe(600_000);
    expect(parseDurationMs('1h 30m')).toBe(5_400_000);
    expect(parseDurationMs(' 5MIN ')).toBe(300_000);
  });

  it('rejects unitless, unknown-unit, zero, and empty input', () => {
    expect(parseDurationMs('10')).toBeUndefined();
    expect(parseDurationMs('10 parsecs')).toBeUndefined();
    expect(parseDurationMs('0s')).toBeUndefined();
    expect(parseDurationMs('')).toBeUndefined();
    expect(parseDurationMs('abc')).toBeUndefined();
  });
});

describe('buildProjectEntry — NodeJS', () => {
  const entry = buildProjectEntry(nodeOpts);

  it('writes the NodeJS runtime shape', () => {
    expect(entry).toMatchObject({
      projectName: 'my-tunnel-app',
      fileUrl: 'index.js',
      entrypoint: 'index.js',
      runtime: 'NodeJS',
      network: 'mainnet',
      requiredModules: [],
      minProcessorVersions: { android: '1.26.0' },
    });
    expect(entry).not.toHaveProperty('image');
  });

  it('keeps CLI-parity defaults', () => {
    expect(entry).toMatchObject({
      onlyAttestedDevices: true,
      assignmentStrategy: { type: 'Single' },
      maxAllowedStartDelayInMs: 10_000,
      usageLimit: { maxMemory: 0, maxNetworkRequests: 0, maxStorage: 0 },
      numberOfReplicas: 1,
      minProcessorReputation: 0,
      maxCostPerExecution: 100_000_000_000,
      includeEnvironmentVariables: [],
      processorWhitelist: [],
    });
  });

  it('passes the execution block through', () => {
    expect(entry.execution).toEqual(ONETIME);
    const interval = buildProjectEntry({
      ...nodeOpts,
      execution: { type: 'interval', intervalInMs: 300_000, numberOfExecutions: 5 },
    });
    expect(interval.execution).toEqual({ type: 'interval', intervalInMs: 300_000, numberOfExecutions: 5 });
  });
});

describe('buildProjectEntry — Shell', () => {
  it('writes the Shell runtime shape with the picked image', () => {
    expect(buildProjectEntry(shellOpts)).toMatchObject({
      projectName: 'cargo-tunnel',
      fileUrl: 'app',
      entrypoint: 'start.sh',
      runtime: 'Shell',
      image: shellOpts.image,
      requiredModules: ['Shell'],
      minProcessorVersions: { android: '1.26.0' },
    });
  });

  it('leaves an empty image block to fill in later when none was picked', () => {
    const entry = buildProjectEntry({ ...shellOpts, image: undefined });
    expect(entry.image).toEqual({ url: '', sha256: '' });
  });
});

describe('buildScaffold', () => {
  it('NodeJS: acurast.json, index.js, package.json, .gitignore, README', () => {
    const { files, executable } = buildScaffold(nodeOpts);
    expect(Object.keys(files).sort()).toEqual(
      ['.gitignore', 'README.md', 'acurast.json', 'index.js', 'package.json'].sort()
    );
    expect(executable).toEqual([]);
    expect(files['.gitignore']).toContain('node_modules/');
    expect(JSON.parse(files['package.json'])).toMatchObject({ name: 'my-tunnel-app', main: 'index.js' });
  });

  it('Shell: acurast.json, app/start.sh (+x), .gitignore, README', () => {
    const { files, executable } = buildScaffold(shellOpts);
    expect(Object.keys(files).sort()).toEqual(
      ['.gitignore', 'README.md', 'acurast.json', 'app/start.sh'].sort()
    );
    expect(executable).toEqual(['app/start.sh']);
    expect(files['app/start.sh'].startsWith('#!/bin/sh\n')).toBe(true);
    expect(files['.gitignore']).not.toContain('node_modules');
  });

  it('nests the project entry under projects.<name> in valid JSON', () => {
    const { files } = buildScaffold(shellOpts);
    const parsed = JSON.parse(files['acurast.json']);
    expect(parsed.projects['cargo-tunnel']).toEqual(buildProjectEntry(shellOpts));
  });

  it('calls out a pending image in the README only when it was skipped', () => {
    expect(buildScaffold({ ...shellOpts, image: undefined }).files['README.md']).toContain('Before deploying');
    expect(buildScaffold(shellOpts).files['README.md']).not.toContain('Before deploying');
    expect(buildScaffold(nodeOpts).files['README.md']).not.toContain('Before deploying');
  });
});
