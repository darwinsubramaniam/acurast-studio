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
    constructor(public value: string) {}
  }
  return {
    EventEmitter,
    MarkdownString,
    StatusBarAlignment: { Right: 1, Left: 2 },
    window: { createStatusBarItem: vi.fn(() => mockItem) },
  };
});

import { WalletStatusBar } from '../../wallet/walletStatusBar';
import type { WalletInfo, WalletChange } from '../../wallet/walletService';

type ChangeListener = (e: WalletChange) => void;

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

describe('WalletStatusBar', () => {
  describe('construction', () => {
    it('sets the command on the status bar item', () => {
      const wallet = makeWalletMock();
      new WalletStatusBar(wallet as any);
      expect(mockItem.command).toBe('acurast.studio.showWallets');
    });

    it('subscribes to wallet.onDidChange', () => {
      const wallet = makeWalletMock();
      new WalletStatusBar(wallet as any);
      expect(wallet.onDidChange).toHaveBeenCalledOnce();
    });
  });

  describe('with no active wallet', () => {
    it('calls hide() on the status bar item', async () => {
      const wallet = makeWalletMock(undefined);
      new WalletStatusBar(wallet as any);
      await flush();
      expect(mockItem.hide).toHaveBeenCalled();
      expect(mockItem.show).not.toHaveBeenCalled();
    });
  });

  describe('with an active wallet', () => {
    it('calls show() on the status bar item', async () => {
      const wallet = makeWalletMock(WALLET);
      new WalletStatusBar(wallet as any);
      await flush();
      expect(mockItem.show).toHaveBeenCalled();
      expect(mockItem.hide).not.toHaveBeenCalled();
    });

    it('sets text with wallet name and abbreviated address', async () => {
      const wallet = makeWalletMock(WALLET);
      new WalletStatusBar(wallet as any);
      await flush();
      const short = `${WALLET.address.slice(0, 6)}…${WALLET.address.slice(-4)}`;
      expect(mockItem.text).toBe(`$(acurast-logo) ${WALLET.name} ${short}`);
    });

    it('sets tooltip containing the name and full address', async () => {
      const wallet = makeWalletMock(WALLET);
      new WalletStatusBar(wallet as any);
      await flush();
      expect(mockItem.tooltip.value).toContain(WALLET.name);
      expect(mockItem.tooltip.value).toContain(WALLET.address);
    });

    it('includes description in tooltip when present', async () => {
      const wallet = makeWalletMock(WALLET);
      new WalletStatusBar(wallet as any);
      await flush();
      expect(mockItem.tooltip.value).toContain(WALLET.description);
    });

    it('omits description from tooltip when empty', async () => {
      const noDesc = { ...WALLET, description: '' };
      const wallet = makeWalletMock(noDesc);
      new WalletStatusBar(wallet as any);
      await flush();
      expect(mockItem.tooltip.value).not.toContain('_');
    });
  });

  describe('onDidChange', () => {
    it('hides the item when wallet is removed', async () => {
      const wallet = makeWalletMock(WALLET);
      new WalletStatusBar(wallet as any);
      await flush();

      wallet.getActive.mockResolvedValue(undefined);
      wallet.emit({ wallets: [], activeId: undefined });
      await flush();

      expect(mockItem.hide).toHaveBeenCalled();
    });

    it('updates text when active wallet changes', async () => {
      const wallet = makeWalletMock(WALLET);
      new WalletStatusBar(wallet as any);
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
      const bar = new WalletStatusBar(wallet as any);
      bar.dispose();
      expect(mockItem.dispose).toHaveBeenCalled();
    });
  });
});
