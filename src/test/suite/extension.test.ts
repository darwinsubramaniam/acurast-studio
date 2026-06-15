import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'dw3labs.acurast-studio';

async function getActivatedExtension() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `Extension ${EXT_ID} not found`);
  if (!ext.isActive) {
    await ext.activate();
  }
  return ext;
}

suite('Extension lifecycle', () => {
  test('extension is present in the host', () => {
    assert.ok(vscode.extensions.getExtension(EXT_ID));
  });

  test('extension activates without error', async () => {
    const ext = await getActivatedExtension();
    assert.strictEqual(ext.isActive, true);
  });
});

suite('Command registration', () => {
  const expectedCommands = [
    'acurast.newProject',
    'acurast.deploy',
    'acurast.estimateCost',
    'acurast.openDashboard',
    'acurast.studio.home',
    'acurast.studio.showTunnel',
    'acurast.setActiveConfig',
    'acurast.chooseConfig',
    'acurast.clearActiveConfig',
    'acurast.wallet.create',
    'acurast.wallet.import',
    'acurast.wallet.reveal',
    'acurast.wallet.delete',
    'acurast.wallet.copyAddress',
    'acurast.wallet.rename',
    'acurast.wallet.editDescription',
    'acurast.wallet.setActive',
  ];

  let registeredCommands: string[];

  suiteSetup(async () => {
    await getActivatedExtension();
    registeredCommands = await vscode.commands.getCommands(true);
  });

  for (const cmd of expectedCommands) {
    test(`${cmd} is registered`, () => {
      assert.ok(
        registeredCommands.includes(cmd),
        `Command '${cmd}' was not registered`
      );
    });
  }
});

suite('Configuration defaults', () => {
  let cfg: vscode.WorkspaceConfiguration;

  suiteSetup(() => {
    cfg = vscode.workspace.getConfiguration('acurast');
  });

  test('acurast.network defaults to "mainnet"', () => {
    assert.strictEqual(cfg.get('network'), 'mainnet');
  });

  test('acurast.fiat.exchangerId defaults to 2 (CoinGecko)', () => {
    assert.strictEqual(cfg.get('fiat.exchangerId'), 2);
  });

  test('acurast.fiat.coingecko.plan defaults to "demo"', () => {
    assert.strictEqual(cfg.get('fiat.coingecko.plan'), 'demo');
  });

  test('acurast.useKeychainForMnemonic defaults to true', () => {
    assert.strictEqual(cfg.get('useKeychainForMnemonic'), true);
  });

  test('acurast.fiat.currencyId defaults to empty string', () => {
    assert.strictEqual(cfg.get('fiat.currencyId'), '');
  });

  test('acurast.tunnelRelays defaults to an empty object', () => {
    assert.deepStrictEqual(cfg.get('tunnelRelays'), {});
  });
});

suite('Language registration', () => {
  test('acurast-config language is registered', async () => {
    const languages = await vscode.languages.getLanguages();
    assert.ok(
      languages.includes('acurast-config'),
      `'acurast-config' language not found. Registered: ${languages.join(', ')}`
    );
  });
});
