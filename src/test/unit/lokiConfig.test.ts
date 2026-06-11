import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted config + secret stores so the vscode mock factory can reach them.
const { store } = vi.hoisted(() => ({
  store: {
    settings: {} as Record<string, unknown>,
    secrets: {} as Record<string, string>,
  },
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, def: unknown) =>
        key in store.settings ? store.settings[key] : def,
    }),
  },
}));

import {
  resolveLokiConfig,
  escapeLabelValue,
  jobSelector,
  LOKI_BEARER_SECRET,
  LOKI_BASIC_PASSWORD_SECRET,
} from '../../loki/lokiConfig';

const secrets = {
  get: async (k: string) => store.secrets[k],
  store: async () => {},
  delete: async () => {},
  onDidChange: () => ({ dispose() {} }),
} as unknown as import('vscode').SecretStorage;

beforeEach(() => {
  store.settings = {};
  store.secrets = {};
});

describe('escapeLabelValue', () => {
  it('escapes backslashes and double quotes', () => {
    expect(escapeLabelValue('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

describe('jobSelector', () => {
  it('builds an auto-scoped LogQL selector', () => {
    expect(jobSelector('job_id', 42)).toBe('{job_id="42"}');
  });
});

describe('resolveLokiConfig', () => {
  it('falls back to the default endpoint when no override is set', async () => {
    const cfg = await resolveLokiConfig('mainnet', secrets);
    expect(cfg.configured).toBe(true);
    expect(cfg.baseUrl).toBe('https://logs.acurast.com');
    expect(cfg.jobLabel).toBe('job_id');
  });

  it('uses a per-network override and strips a trailing slash', async () => {
    store.settings['loki.urls'] = { mainnet: 'https://logs.example.com/' };
    const cfg = await resolveLokiConfig('mainnet', secrets);
    expect(cfg.baseUrl).toBe('https://logs.example.com');
  });

  it('adds the X-Scope-OrgID header when a tenant is set', async () => {
    store.settings['loki.orgId'] = 'tenant-1';
    const cfg = await resolveLokiConfig('mainnet', secrets);
    expect(cfg.headers['X-Scope-OrgID']).toBe('tenant-1');
  });

  it('prefers a bearer token over basic auth', async () => {
    store.secrets[LOKI_BEARER_SECRET] = 'tok';
    store.settings['loki.basicAuthUser'] = 'user';
    store.secrets[LOKI_BASIC_PASSWORD_SECRET] = 'pass';
    const cfg = await resolveLokiConfig('mainnet', secrets);
    expect(cfg.headers['Authorization']).toBe('Bearer tok');
  });

  it('builds a Basic header from user + password when no bearer is set', async () => {
    store.settings['loki.basicAuthUser'] = 'user';
    store.secrets[LOKI_BASIC_PASSWORD_SECRET] = 'pass';
    const cfg = await resolveLokiConfig('mainnet', secrets);
    const expected = 'Basic ' + Buffer.from('user:pass').toString('base64');
    expect(cfg.headers['Authorization']).toBe(expected);
  });

  it('honours a custom job label', async () => {
    store.settings['loki.jobLabel'] = 'acurast_job';
    const cfg = await resolveLokiConfig('mainnet', secrets);
    expect(cfg.jobLabel).toBe('acurast_job');
  });
});
