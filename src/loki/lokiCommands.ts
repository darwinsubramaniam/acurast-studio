import * as vscode from 'vscode';
import { LokiClient } from './lokiClient';
import { resolveLokiConfig, LOKI_BEARER_SECRET, LOKI_BASIC_PASSWORD_SECRET } from './lokiConfig';

/**
 * Interactive setup for the Live Monitoring Loki endpoint. Settings (URL,
 * org id, basic-auth user, job label) are written to user settings; secrets
 * (bearer token, basic-auth password) go to SecretStorage.
 */
export function registerLokiCommands(secrets: vscode.SecretStorage): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('acurast.loki.configure', () => configureLoki(secrets)),
    vscode.commands.registerCommand('acurast.loki.testConnection', () => testConnection(secrets)),
  ];
}

async function configureLoki(secrets: vscode.SecretStorage): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { id: 'url', label: '$(link) Endpoint URL', description: 'Loki base URL (per network)' },
      { id: 'orgId', label: '$(organization) Tenant (X-Scope-OrgID)', description: 'Multi-tenant Loki tenant id' },
      { id: 'bearer', label: '$(key) Bearer token', description: 'Authorization: Bearer …' },
      { id: 'basic', label: '$(account) Basic auth', description: 'Username + password (e.g. Grafana Cloud)' },
      { id: 'jobLabel', label: '$(tag) Job label', description: 'Stream label carrying the job id' },
      { id: 'clear', label: '$(trash) Clear stored credentials', description: 'Remove bearer + basic-auth secrets' },
      { id: 'test', label: '$(debug-disconnect) Test connection', description: 'Ping the configured endpoint' },
    ],
    { title: 'Configure Loki log source', placeHolder: 'What do you want to set?' }
  );
  if (!pick) return;
  const cfg = vscode.workspace.getConfiguration('acurast');

  switch (pick.id) {
    case 'url': {
      const network = await pickNetwork();
      if (!network) return;
      const overrides = { ...(cfg.get<Record<string, string>>('loki.urls', {}) ?? {}) };
      const value = await vscode.window.showInputBox({
        title: `Loki URL for ${network}`,
        prompt: 'Base URL, e.g. https://logs.example.com (leave blank to use the default)',
        value: overrides[network] ?? '',
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      if (value.trim()) overrides[network] = value.trim();
      else delete overrides[network];
      await cfg.update('loki.urls', overrides, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Saved Loki URL for ${network}.`);
      break;
    }
    case 'orgId': {
      const value = await vscode.window.showInputBox({
        title: 'X-Scope-OrgID (tenant)',
        value: cfg.get<string>('loki.orgId', ''),
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      await cfg.update('loki.orgId', value.trim(), vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Saved Loki tenant id.');
      break;
    }
    case 'bearer': {
      const token = await vscode.window.showInputBox({
        title: 'Loki bearer token',
        prompt: 'Stored securely in the OS keychain. Leave blank to remove.',
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) return;
      if (token.trim()) await secrets.store(LOKI_BEARER_SECRET, token.trim());
      else await secrets.delete(LOKI_BEARER_SECRET);
      vscode.window.showInformationMessage(token.trim() ? 'Saved Loki bearer token.' : 'Removed Loki bearer token.');
      break;
    }
    case 'basic': {
      const user = await vscode.window.showInputBox({
        title: 'Loki basic-auth username',
        value: cfg.get<string>('loki.basicAuthUser', ''),
        ignoreFocusOut: true,
      });
      if (user === undefined) return;
      await cfg.update('loki.basicAuthUser', user.trim(), vscode.ConfigurationTarget.Global);
      const pass = await vscode.window.showInputBox({
        title: 'Loki basic-auth password',
        prompt: 'Stored securely in the OS keychain. Leave blank to remove.',
        password: true,
        ignoreFocusOut: true,
      });
      if (pass === undefined) return;
      if (pass.trim()) await secrets.store(LOKI_BASIC_PASSWORD_SECRET, pass.trim());
      else await secrets.delete(LOKI_BASIC_PASSWORD_SECRET);
      vscode.window.showInformationMessage('Saved Loki basic-auth credentials.');
      break;
    }
    case 'jobLabel': {
      const value = await vscode.window.showInputBox({
        title: 'Job label',
        prompt: 'Stream label that carries the job local id (default: job_id)',
        value: cfg.get<string>('loki.jobLabel', 'job_id'),
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      await cfg.update('loki.jobLabel', value.trim(), vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Saved Loki job label.');
      break;
    }
    case 'clear': {
      await secrets.delete(LOKI_BEARER_SECRET);
      await secrets.delete(LOKI_BASIC_PASSWORD_SECRET);
      vscode.window.showInformationMessage('Cleared stored Loki credentials.');
      break;
    }
    case 'test':
      await testConnection(secrets);
      break;
  }
}

async function pickNetwork(): Promise<string | undefined> {
  const choice = await vscode.window.showQuickPick(['mainnet', 'canary'], {
    title: 'Which network?',
    placeHolder: 'Loki URLs are configured per network',
  });
  return choice;
}

async function testConnection(secrets: vscode.SecretStorage): Promise<void> {
  const network = await pickNetwork();
  if (!network) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Pinging Loki (${network})…` },
    async () => {
      try {
        const cfg = await resolveLokiConfig(network, secrets);
        if (!cfg.configured) {
          vscode.window.showWarningMessage('No Loki endpoint configured for this network.');
          return;
        }
        await new LokiClient(cfg).ping();
        vscode.window.showInformationMessage(`Loki reachable at ${cfg.baseUrl}.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Loki connection failed: ${(err as Error).message}`);
      }
    }
  );
}
