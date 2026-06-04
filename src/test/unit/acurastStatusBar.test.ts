import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockItem } = vi.hoisted(() => ({
  mockItem: {
    command: undefined as string | undefined,
    text: '',
    tooltip: undefined as any,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(event: T) { this.listeners.forEach(l => l(event)); }
  }
  class MarkdownString {
    value: string;
    constructor(v?: string) { this.value = v ?? ''; }
    appendMarkdown(v: string) { this.value += v; return this; }
  }
  class ThemeColor { constructor(public id: string) {} }
  return {
    EventEmitter,
    MarkdownString,
    ThemeColor,
    StatusBarAlignment: { Right: 1, Left: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    window: {
      createStatusBarItem: vi.fn(() => mockItem),
      showQuickPick: vi.fn(),
      showWarningMessage: vi.fn(),
      setStatusBarMessage: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose: () => {} })),
      executeCommand: vi.fn(),
    },
    env: { clipboard: { writeText: vi.fn() } },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: (_key: string, def: unknown) => def,
        inspect: () => ({}),
        update: vi.fn(),
      })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
      onDidSaveTextDocument: vi.fn(() => ({ dispose: () => {} })),
    },
  };
});

vi.mock('@acurast/sdk/deploy', () => ({
  // No active project in these tests → no acurast.json network → no mismatch.
  loadAcurastConfig: vi.fn(() => undefined),
}));

import { AcurastStatusBar } from '../../wallet/acurastStatusBar';
import type { WalletInfo, WalletChange } from '../../wallet/walletService';

type ChangeListener = (e: WalletChange) => void;

function makeCtx() {
  return {
    configPath: undefined as string | undefined,
    onDidChangeActiveConfig: vi.fn(() => ({ dispose: () => {} })),
  };
}

function makeWalletMock(active?: WalletInfo) {
  let listener: ChangeListener | undefined;
  return {
    getActive: vi.fn().mockResolvedValue(active),
    onDidChange: vi.fn((cb: ChangeListener) => {
      listener = cb;
      return { dispose: () => {} };
    }),
    emit: (change: WalletChange) => listener?.(change),
  };
}

const WALLET: WalletInfo = {
  id: 'abcdef01234567',
  address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
  publicKey: 'abcdef0123456789',
  name: 'Main Wallet',
  description: 'My main deployer',
};

// flush async microtasks queued by the constructor's void this.refresh()
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockItem.text = '';
  mockItem.tooltip = undefined;
  mockItem.command = undefined;
});

describe('AcurastStatusBar', () => {
  describe('construction', () => {
    it('wires the status bar item to the quick-pick menu command', () => {
      const wallet = makeWalletMock();
      new AcurastStatusBar(wallet as any, makeCtx() as any);
      expect(mockItem.command).toBe('acurast.studio.statusBarMenu');
    });

    it('subscribes to wallet.onDidChange', () => {
      const wallet = makeWalletMock();
      new AcurastStatusBar(wallet as any, makeCtx() as any);
      expect(wallet.onDidChange).toHaveBeenCalledOnce();
    });
  });

  describe('with no active wallet', () => {
    it('calls hide() on the status bar item', async () => {
      const wallet = makeWalletMock(undefined);
      new AcurastStatusBar(wallet as any, makeCtx() as any);
      await flush();
      expect(mockItem.hide).toHaveBeenCalled();
      expect(mockItem.show).not.toHaveBeenCalled();
    });
  });

  describe('with an active wallet', () => {
    it('calls show() on the status bar item', async () => {
      const wallet = makeWalletMock(WALLET);
      new AcurastStatusBar(wallet as any, makeCtx() as any);
      await flush();
      expect(mockItem.show).toHaveBeenCalled();
      expect(mockItem.hide).not.toHaveBeenCalled();
    });

    it('sets text with network first then wallet name', async () => {
      const wallet = makeWalletMock(WALLET);
      new AcurastStatusBar(wallet as any, makeCtx() as any);
      await flush();
      expect(mockItem.text).toBe(`$(acurast-logo) Mainnet · ${WALLET.name}`);
    });

    it('sets tooltip containing the name and full address', async () => {
      const wallet = makeWalletMock(WALLET);
      new AcurastStatusBar(wallet as any, makeCtx() as any);
      await flush();
      expect(mockItem.tooltip.value).toContain(WALLET.name);
      expect(mockItem.tooltip.value).toContain(WALLET.address);
    });

    it('includes description in tooltip when present', async () => {
      const wallet = makeWalletMock(WALLET);
      new AcurastStatusBar(wallet as any, makeCtx() as any);
      await flush();
      expect(mockItem.tooltip.value).toContain(WALLET.description);
    });

    it('omits description from tooltip when empty', async () => {
      const noDesc = { ...WALLET, description: '' };
      const wallet = makeWalletMock(noDesc);
      new AcurastStatusBar(wallet as any, makeCtx() as any);
      await flush();
      expect(mockItem.tooltip.value).not.toContain('_');
    });
  });

  describe('onDidChange', () => {
    it('hides the item when wallet is removed', async () => {
      const wallet = makeWalletMock(WALLET);
      new AcurastStatusBar(wallet as any, makeCtx() as any);
      await flush();

      wallet.getActive.mockResolvedValue(undefined);
      wallet.emit({ wallets: [], activeId: undefined });
      await flush();

      expect(mockItem.hide).toHaveBeenCalled();
    });

    it('updates text when active wallet changes', async () => {
      const wallet = makeWalletMock(WALLET);
      new AcurastStatusBar(wallet as any, makeCtx() as any);
      await flush();

      const updated = { ...WALLET, name: 'Renamed' };
      wallet.getActive.mockResolvedValue(updated);
      wallet.emit({ wallets: [updated], activeId: updated.id });
      await flush();

      expect(mockItem.text).toContain('Renamed');
    });
  });

  describe('dispose()', () => {
    it('disposes the status bar item', () => {
      const wallet = makeWalletMock();
      const bar = new AcurastStatusBar(wallet as any, makeCtx() as any);
      bar.dispose();
      expect(mockItem.dispose).toHaveBeenCalled();
    });
  });
});
