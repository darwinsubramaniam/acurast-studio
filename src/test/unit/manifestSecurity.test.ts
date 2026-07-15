import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Guards the Workspace-Trust hardening in package.json: settings that redirect a
// host-side executable (cliPath) or a network endpoint (rpc/matcher/relays) must
// NOT be overridable by an untrusted workspace's `.vscode/settings.json`. VS Code
// only defers a workspace setting to the trusted state when it is named in
// `capabilities.untrustedWorkspaces.restrictedConfigurations`.
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'),
) as {
  capabilities?: { untrustedWorkspaces?: { restrictedConfigurations?: string[] } };
  contributes?: { configuration?: { properties?: Record<string, { scope?: string }> } };
};

describe('manifest security posture', () => {
  const restricted = pkg.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];

  it.each([
    'acurast.cliPath',
    'acurast.rpcOverrides',
    'acurast.matcherUrls',
    'acurast.tunnelRelays',
  ])('restricts %s in untrusted workspaces', (setting) => {
    expect(restricted).toContain(setting);
  });

  it('scopes the CLI executable path to machine so a workspace cannot override it', () => {
    const props = pkg.contributes?.configuration?.properties ?? {};
    expect(props['acurast.cliPath']?.scope).toBe('machine');
  });
});
