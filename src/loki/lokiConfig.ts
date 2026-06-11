import * as vscode from 'vscode';
import { LOKI_ENDPOINTS, LOKI_DEFAULT_JOB_LABEL, type AcurastNetwork } from '../sdk/constants';

/** SecretStorage keys for the two credential kinds that must not live in settings. */
export const LOKI_BEARER_SECRET = 'acurast.loki.bearerToken';
export const LOKI_BASIC_PASSWORD_SECRET = 'acurast.loki.basicAuthPassword';

export interface ResolvedLokiConfig {
  /** Base URL with any trailing slash stripped; '' when not configured. */
  baseUrl: string;
  /** Whether a usable base URL is present. */
  configured: boolean;
  /** Request headers including any auth the user configured. */
  headers: Record<string, string>;
  /** Stream label that carries the job's local id. */
  jobLabel: string;
}

/**
 * Resolve the Loki endpoint + auth for a network from settings and SecretStorage.
 * Precedence for the URL: `acurast.loki.urls[network]` → `LOKI_ENDPOINTS[network]`.
 * Auth (any combination): X-Scope-OrgID (multi-tenant), Bearer token, Basic auth.
 */
export async function resolveLokiConfig(
  network: string,
  secrets: vscode.SecretStorage
): Promise<ResolvedLokiConfig> {
  const cfg = vscode.workspace.getConfiguration('acurast');
  const overrides = cfg.get<Partial<Record<AcurastNetwork, string>>>('loki.urls', {}) ?? {};
  const fallback = LOKI_ENDPOINTS[network as AcurastNetwork] ?? '';
  const raw = (overrides[network as AcurastNetwork] ?? fallback ?? '').trim();
  const baseUrl = raw.replace(/\/+$/, '');

  const headers: Record<string, string> = { Accept: 'application/json' };

  const orgId = (cfg.get<string>('loki.orgId', '') ?? '').trim();
  if (orgId) headers['X-Scope-OrgID'] = orgId;

  const bearer = (await secrets.get(LOKI_BEARER_SECRET))?.trim();
  if (bearer) {
    headers['Authorization'] = `Bearer ${bearer}`;
  } else {
    // Bearer wins over basic when both are set; basic only applies otherwise.
    const user = (cfg.get<string>('loki.basicAuthUser', '') ?? '').trim();
    const pass = (await secrets.get(LOKI_BASIC_PASSWORD_SECRET))?.trim();
    if (user || pass) {
      const token = Buffer.from(`${user}:${pass ?? ''}`).toString('base64');
      headers['Authorization'] = `Basic ${token}`;
    }
  }

  const jobLabel = (cfg.get<string>('loki.jobLabel', LOKI_DEFAULT_JOB_LABEL) || LOKI_DEFAULT_JOB_LABEL).trim();

  return { baseUrl, configured: Boolean(baseUrl), headers, jobLabel };
}

/** Escape a value for safe use inside a LogQL `{label="..."}` matcher. */
export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Build the auto-scoped LogQL selector for a job's local id. */
export function jobSelector(jobLabel: string, localId: number): string {
  return `{${jobLabel}="${escapeLabelValue(String(localId))}"}`;
}
