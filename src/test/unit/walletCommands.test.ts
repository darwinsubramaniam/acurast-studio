import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- vscode mock -----------------------------------------------------------

const { handlers, showInputBox, showQuickPick, showWarningMessage, showInformationMessage, showErrorMessage, clipboardWrite } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  clipboardWrite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: any[]) => any) => {
      handlers.set(id, handler);
      return { dispose: () => {} };
    }),
  },
  window: { showInputBox, showQuickPick, showWarningMessage, showInformationMessage, showErrorMessage },
  env: { clipboard: { writeText: clipboardWrite } },
}));

// --- wallet mock -----------------------------------------------------------

import { registerWalletCommands } from '../../wallet/walletCommands';
import type { WalletInfo } from '../../wallet/walletService';

const WALLET: WalletInfo = {
  id: 'abc123',
  address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
  publicKey: 'abc123pubkey',
  name: 'Main',
  description: 'deployer',
};

function makeWallet(overrides: Partial<Record<keyof ReturnType<typeof makeWallet>, any>> = {}) {
  return {
    list: vi.fn().mockResolvedValue([WALLET]),
    getInfo: vi.fn().mockResolvedValue(WALLET),
    create: vi.fn().mockResolvedValue({ mnemonic: 'word '.repeat(12).trim(), info: WALLET }),
    import: vi.fn().mockResolvedValue(WALLET),
    updateMetadata: vi.fn().mockResolvedValue({ ...WALLET }),
    reveal: vi.fn().mockResolvedValue('word '.repeat(12).trim()),
    delete: vi.fn().mockResolvedValue(undefined),
    setActive: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// helper — invoke a registered command handler by id
function run(id: string, ...args: any[]) {
  const h = handlers.get(id);
  if (!h) throw new Error(`Handler not registered: ${id}`);
  return h(...args);
}

beforeEach(() => {
  vi.resetAllMocks();
  clipboardWrite.mockResolvedValue(undefined);
  handlers.clear();
});

// ---------------------------------------------------------------------------

describe('registerWalletCommands', () => {
  it('registers all 8 wallet commands', () => {
    registerWalletCommands(makeWallet() as any);
    const expected = [
      'acurast.wallet.create', 'acurast.wallet.import',
      'acurast.wallet.reveal', 'acurast.wallet.delete',
      'acurast.wallet.copyAddress', 'acurast.wallet.rename',
      'acurast.wallet.editDescription', 'acurast.wallet.setActive',
    ];
    for (const id of expected) expect(handlers.has(id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('acurast.wallet.create', () => {
  it('calls wallet.create() with metadata and password on full flow', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);

    showInputBox
      .mockResolvedValueOnce('My Wallet')   // name
      .mockResolvedValueOnce('deployer')     // description
      .mockResolvedValueOnce('secret1234')   // password
      .mockResolvedValueOnce('secret1234');  // confirm
    showWarningMessage.mockResolvedValueOnce('I have backed it up');

    await run('acurast.wallet.create');

    expect(wallet.create).toHaveBeenCalledWith(
      { name: 'My Wallet', description: 'deployer' },
      'secret1234'
    );
  });

  it('does not call wallet.create() when user cancels name prompt', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showInputBox.mockResolvedValueOnce(undefined); // cancel

    await run('acurast.wallet.create');
    expect(wallet.create).not.toHaveBeenCalled();
  });

  it('does not call wallet.create() when user cancels password prompt', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showInputBox
      .mockResolvedValueOnce('Name')
      .mockResolvedValueOnce('desc')
      .mockResolvedValueOnce(undefined); // cancel password

    await run('acurast.wallet.create');
    expect(wallet.create).not.toHaveBeenCalled();
  });

  it('shows error message when wallet.create() throws', async () => {
    const wallet = makeWallet({ create: vi.fn().mockRejectedValue(new Error('disk full')) });
    registerWalletCommands(wallet as any);
    showInputBox
      .mockResolvedValueOnce('Name')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('password1')
      .mockResolvedValueOnce('password1');

    await run('acurast.wallet.create');
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});

// ---------------------------------------------------------------------------

describe('acurast.wallet.import', () => {
  const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('calls wallet.import() with mnemonic, metadata and password', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showInputBox
      .mockResolvedValueOnce(MNEMONIC)    // mnemonic
      .mockResolvedValueOnce('Imported')  // name
      .mockResolvedValueOnce('')          // description
      .mockResolvedValueOnce('pass1234')  // password
      .mockResolvedValueOnce('pass1234'); // confirm
    showInformationMessage.mockResolvedValueOnce(undefined);

    await run('acurast.wallet.import');

    expect(wallet.import).toHaveBeenCalledWith(
      MNEMONIC,
      { name: 'Imported', description: '' },
      'pass1234'
    );
  });

  it('does not import when user cancels mnemonic prompt', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showInputBox.mockResolvedValueOnce(undefined);

    await run('acurast.wallet.import');
    expect(wallet.import).not.toHaveBeenCalled();
  });

  it('shows error when wallet.import() throws', async () => {
    const wallet = makeWallet({ import: vi.fn().mockRejectedValue(new Error('already exists')) });
    registerWalletCommands(wallet as any);
    showInputBox
      .mockResolvedValueOnce(MNEMONIC)
      .mockResolvedValueOnce('W')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('pass1234')
      .mockResolvedValueOnce('pass1234');

    await run('acurast.wallet.import');
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('already exists'));
  });
});

// ---------------------------------------------------------------------------

describe('acurast.wallet.reveal', () => {
  it('calls wallet.reveal() with the id and entered password', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showInputBox.mockResolvedValueOnce('mypassword');
    showInformationMessage.mockResolvedValueOnce(undefined);

    await run('acurast.wallet.reveal', WALLET.id);
    expect(wallet.reveal).toHaveBeenCalledWith(WALLET.id, 'mypassword');
  });

  it('copies mnemonic to clipboard when user picks "Copy to Clipboard"', async () => {
    const mnemonic = 'word '.repeat(12).trim();
    const wallet = makeWallet({ reveal: vi.fn().mockResolvedValue(mnemonic) });
    registerWalletCommands(wallet as any);
    showInputBox.mockResolvedValueOnce('mypassword');
    showInformationMessage.mockResolvedValueOnce('Copy to Clipboard');

    await run('acurast.wallet.reveal', WALLET.id);
    expect(clipboardWrite).toHaveBeenCalledWith(mnemonic);
  });

  it('shows error when wallet.reveal() throws (wrong password)', async () => {
    const wallet = makeWallet({ reveal: vi.fn().mockRejectedValue(new Error('Incorrect password.')) });
    registerWalletCommands(wallet as any);
    showInputBox.mockResolvedValueOnce('wrongpass');

    await run('acurast.wallet.reveal', WALLET.id);
    expect(showErrorMessage).toHaveBeenCalledWith('Incorrect password.');
  });

  it('does not call reveal when user cancels password prompt', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showInputBox.mockResolvedValueOnce(undefined);

    await run('acurast.wallet.reveal', WALLET.id);
    expect(wallet.reveal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('acurast.wallet.delete', () => {
  it('calls wallet.delete() when user confirms', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showWarningMessage.mockResolvedValueOnce('Delete');

    await run('acurast.wallet.delete', WALLET.id);
    expect(wallet.delete).toHaveBeenCalledWith(WALLET.id);
  });

  it('does not delete when user dismisses the confirmation', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showWarningMessage.mockResolvedValueOnce(undefined);

    await run('acurast.wallet.delete', WALLET.id);
    expect(wallet.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('acurast.wallet.copyAddress', () => {
  it('copies the wallet address to the clipboard', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);

    await run('acurast.wallet.copyAddress', WALLET.id);
    expect(clipboardWrite).toHaveBeenCalledWith(WALLET.address);
  });
});

// ---------------------------------------------------------------------------

describe('acurast.wallet.rename', () => {
  it('calls wallet.updateMetadata() with the new name', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showInputBox.mockResolvedValueOnce('New Name');

    await run('acurast.wallet.rename', WALLET.id);
    expect(wallet.updateMetadata).toHaveBeenCalledWith(WALLET.id, { name: 'New Name' });
  });

  it('does not update when user cancels the name prompt', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showInputBox.mockResolvedValueOnce(undefined);

    await run('acurast.wallet.rename', WALLET.id);
    expect(wallet.updateMetadata).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('acurast.wallet.editDescription', () => {
  it('calls wallet.updateMetadata() with the new description', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showInputBox.mockResolvedValueOnce('Updated description');

    await run('acurast.wallet.editDescription', WALLET.id);
    expect(wallet.updateMetadata).toHaveBeenCalledWith(WALLET.id, { description: 'Updated description' });
  });

  it('does not update when user cancels', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);
    showInputBox.mockResolvedValueOnce(undefined);

    await run('acurast.wallet.editDescription', WALLET.id);
    expect(wallet.updateMetadata).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('acurast.wallet.setActive', () => {
  it('calls wallet.setActive() with the resolved wallet id', async () => {
    const wallet = makeWallet();
    registerWalletCommands(wallet as any);

    await run('acurast.wallet.setActive', WALLET.id);
    expect(wallet.setActive).toHaveBeenCalledWith(WALLET.id);
  });
});

// ---------------------------------------------------------------------------

describe('pickWallet (no id provided)', () => {
  it('shows info message and skips when wallet list is empty', async () => {
    const wallet = makeWallet({ list: vi.fn().mockResolvedValue([]) });
    registerWalletCommands(wallet as any);

    await run('acurast.wallet.delete'); // no id → pickWallet
    expect(showInformationMessage).toHaveBeenCalledWith('No wallets. Create one first.');
    expect(wallet.delete).not.toHaveBeenCalled();
  });

  it('skips quickpick and uses the only wallet when list has one item', async () => {
    const wallet = makeWallet({ list: vi.fn().mockResolvedValue([WALLET]) });
    registerWalletCommands(wallet as any);
    showWarningMessage.mockResolvedValueOnce('Delete');

    await run('acurast.wallet.delete'); // no id
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(wallet.delete).toHaveBeenCalledWith(WALLET.id);
  });

  it('shows quickpick when list has multiple wallets', async () => {
    const second = { ...WALLET, id: 'def456', name: 'Second' };
    const wallet = makeWallet({ list: vi.fn().mockResolvedValue([WALLET, second]) });
    registerWalletCommands(wallet as any);
    showQuickPick.mockResolvedValueOnce({ info: second });
    showWarningMessage.mockResolvedValueOnce('Delete');

    await run('acurast.wallet.delete'); // no id
    expect(showQuickPick).toHaveBeenCalledOnce();
    expect(wallet.delete).toHaveBeenCalledWith(second.id);
  });
});
