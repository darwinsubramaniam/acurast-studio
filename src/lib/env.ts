// Resolves the `includeEnvironmentVariables` whitelist (a list of variable
// NAMES from acurast.json) to concrete { key, value } pairs for the deploy.
// The Acurast SDK encrypts + submits these but leaves *sourcing the values* to
// the caller, so this is where the project's `.env` is read. Host-only (uses
// `fs`/`process.env`); never imported by the webview bundle.

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

export interface ResolvedDeployEnv {
  /** Whitelisted names that resolved to a value, ready to pass to deployProject. */
  envVars: { key: string; value: string }[];
  /** Whitelisted names with no value in either `.env` or `process.env`. */
  missing: string[];
}

/**
 * Resolve each whitelisted name to a value: the project-root `.env` first,
 * then `process.env`. A name present with an empty value (`KEY=`) counts as
 * intentionally set — only a name absent from BOTH sources is "missing".
 *
 * @param projectRoot Directory holding `acurast.json` (the `.env` lives here).
 * @param names       `config.includeEnvironmentVariables` (may be undefined).
 */
export function resolveDeployEnvVars(
  projectRoot: string,
  names: string[] | undefined,
): ResolvedDeployEnv {
  const wanted = names ?? [];
  if (wanted.length === 0) return { envVars: [], missing: [] };

  let parsed: Record<string, string> = {};
  try {
    parsed = dotenv.parse(fs.readFileSync(path.join(projectRoot, '.env')));
  } catch {
    // .env may be absent — every name then falls back to process.env.
  }

  const envVars: { key: string; value: string }[] = [];
  const missing: string[] = [];
  for (const key of wanted) {
    const value = parsed[key] ?? process.env[key]; // '' is valid; only undefined falls through
    if (value === undefined) missing.push(key);
    else envVars.push({ key, value });
  }
  return { envVars, missing };
}
