import * as vscode from 'vscode';
import { WalletService } from './walletService';
import type { WalletInfo, WalletMetadata } from './walletService';

const MIN_PASSWORD_LEN = 8;
const MAX_NAME_LEN = 40;
const MAX_DESCRIPTION_LEN = 200;

export function registerWalletCommands(wallet: WalletService): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('acurast.wallet.create', () => createWallet(wallet)),
    vscode.commands.registerCommand('acurast.wallet.import', () => importWallet(wallet)),
    vscode.commands.registerCommand('acurast.wallet.reveal', (id?: string) => revealMnemonic(wallet, id)),
    vscode.commands.registerCommand('acurast.wallet.delete', (id?: string) => deleteWallet(wallet, id)),
    vscode.commands.registerCommand('acurast.wallet.copyAddress', (id?: string) => copyAddress(wallet, id)),
    vscode.commands.registerCommand('acurast.wallet.rename', (id?: string) => renameWallet(wallet, id)),
    vscode.commands.registerCommand('acurast.wallet.editDescription', (id?: string) => editDescription(wallet, id)),
    vscode.commands.registerCommand('acurast.wallet.setActive', (id?: string) => setActive(wallet, id)),
  ];
}

async function pickWallet(wallet: WalletService, placeHolder: string): Promise<WalletInfo | undefined> {
  const list = await wallet.list();
  if (!list.length) {
    vscode.window.showInformationMessage('No wallets. Create one first.');
    return undefined;
  }
  if (list.length === 1) return list[0];

  const picked = await vscode.window.showQuickPick(
    list.map((w) => ({
      label: w.name,
      description: `${w.address.slice(0, 8)}…${w.address.slice(-6)}`,
      detail: w.description || undefined,
      info: w,
    })),
    { placeHolder, ignoreFocusOut: true }
  );
  return picked?.info;
}

async function resolveWallet(
  wallet: WalletService,
  id: string | undefined,
  placeHolder: string
): Promise<WalletInfo | undefined> {
  if (id) return wallet.getInfo(id);
  return pickWallet(wallet, placeHolder);
}

async function promptMetadata(current?: Partial<WalletMetadata>): Promise<WalletMetadata | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Wallet name',
    value: current?.name ?? '',
    placeHolder: 'e.g. Main Deployer, Test Wallet',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return 'Name is required';
      if (t.length > MAX_NAME_LEN) return `Max ${MAX_NAME_LEN} characters`;
      return undefined;
    },
  });
  if (name === undefined) return undefined;

  const description = await vscode.window.showInputBox({
    prompt: 'Description (optional)',
    value: current?.description ?? '',
    placeHolder: 'What is this wallet used for?',
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length > MAX_DESCRIPTION_LEN ? `Max ${MAX_DESCRIPTION_LEN} characters` : undefined,
  });
  if (description === undefined) return undefined;

  return { name: name.trim(), description: description.trim() };
}

async function promptNewPassword(): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({
    prompt: 'Set a password to encrypt this wallet',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length < MIN_PASSWORD_LEN ? `Min ${MIN_PASSWORD_LEN} characters` : undefined,
  });
  if (!password) return undefined;

  const confirm = await vscode.window.showInputBox({
    prompt: 'Confirm password',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v === password ? undefined : 'Passwords do not match'),
  });
  if (!confirm) return undefined;
  return password;
}

async function promptExistingPassword(walletName: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: `Enter password for "${walletName}"`,
    password: true,
    ignoreFocusOut: true,
  });
}

async function createWallet(wallet: WalletService) {
  const metadata = await promptMetadata();
  if (!metadata) return;
  const password = await promptNewPassword();
  if (!password) return;

  try {
    const { mnemonic, info } = await wallet.create(metadata, password);
    await vscode.window.showWarningMessage(
      `Wallet "${info.name}" created.\n\nAddress: ${info.address}\n\nRecovery phrase:\n${mnemonic}`,
      {
        modal: true,
        detail: 'Back up this 12-word phrase now. It is the only way to recover the wallet if you forget your password.',
      },
      'I have backed it up'
    );
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Create wallet failed: ${(err as Error).message}`);
  }
}

async function importWallet(wallet: WalletService) {
  const mnemonic = await vscode.window.showInputBox({
    prompt: 'Paste your 12 or 24-word recovery phrase',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const words = v.trim().split(/\s+/).length;
      if (words !== 12 && words !== 24) return 'Must be 12 or 24 words';
      return undefined;
    },
  });
  if (!mnemonic) return;

  const metadata = await promptMetadata();
  if (!metadata) return;
  const password = await promptNewPassword();
  if (!password) return;

  try {
    const info = await wallet.import(mnemonic, metadata, password);
    vscode.window.showInformationMessage(`Wallet "${info.name}" imported: ${info.address}`);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Import failed: ${(err as Error).message}`);
  }
}

async function renameWallet(wallet: WalletService, id?: string) {
  const info = await resolveWallet(wallet, id, 'Select wallet to rename');
  if (!info) return;
  const name = await vscode.window.showInputBox({
    prompt: 'Wallet name',
    value: info.name,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return 'Name is required';
      if (t.length > MAX_NAME_LEN) return `Max ${MAX_NAME_LEN} characters`;
      return undefined;
    },
  });
  if (name === undefined) return;
  await wallet.updateMetadata(info.id, { name: name.trim() });
}

async function editDescription(wallet: WalletService, id?: string) {
  const info = await resolveWallet(wallet, id, 'Select wallet to edit description');
  if (!info) return;
  const description = await vscode.window.showInputBox({
    prompt: 'Wallet description',
    value: info.description,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length > MAX_DESCRIPTION_LEN ? `Max ${MAX_DESCRIPTION_LEN} characters` : undefined,
  });
  if (description === undefined) return;
  await wallet.updateMetadata(info.id, { description: description.trim() });
}

async function revealMnemonic(wallet: WalletService, id?: string) {
  const info = await resolveWallet(wallet, id, 'Select wallet to reveal');
  if (!info) return;

  const password = await promptExistingPassword(info.name);
  if (!password) return;

  let mnemonic: string;
  try {
    mnemonic = await wallet.reveal(info.id, password);
  } catch (err: unknown) {
    vscode.window.showErrorMessage((err as Error).message);
    return;
  }

  const action = await vscode.window.showInformationMessage(
    mnemonic,
    { modal: true, detail: `Recovery phrase for "${info.name}" — copy and store securely.` },
    'Copy to Clipboard'
  );
  if (action === 'Copy to Clipboard') {
    await vscode.env.clipboard.writeText(mnemonic);
    vscode.window.showInformationMessage('Mnemonic copied to clipboard.');
  }
}

async function deleteWallet(wallet: WalletService, id?: string) {
  const info = await resolveWallet(wallet, id, 'Select wallet to delete');
  if (!info) return;
  const confirm = await vscode.window.showWarningMessage(
    `Delete wallet "${info.name}"? This cannot be undone without your backup phrase.`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return;
  await wallet.delete(info.id);
  vscode.window.showInformationMessage(`Wallet "${info.name}" deleted.`);
}

async function copyAddress(wallet: WalletService, id?: string) {
  const info = await resolveWallet(wallet, id, 'Select wallet to copy address');
  if (!info) return;
  await vscode.env.clipboard.writeText(info.address);
  vscode.window.showInformationMessage(`Address copied: ${info.address}`);
}

async function setActive(wallet: WalletService, id?: string) {
  const info = await resolveWallet(wallet, id, 'Select wallet to set as active');
  if (!info) return;
  await wallet.setActive(info.id);
  vscode.window.showInformationMessage(`Active wallet: ${info.name}`);
}
