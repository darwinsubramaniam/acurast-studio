import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(event: T) { this.listeners.forEach(l => l(event)); }
  }
  return { EventEmitter };
});

import { WalletService } from '../../wallet/walletService';
import type { WalletChange } from '../../wallet/walletService';
import type * as vscode from 'vscode';

function makeSecrets(): vscode.SecretStorage {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key),
    store: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    onDidChange: (() => ({ dispose: () => {} })) as any,
  };
}

const PASSWORD = 'correct-password-123';
const ALT_PASSWORD = 'another-password-456';

describe('WalletService', () => {
  let wallet: WalletService;

  beforeEach(() => {
    wallet = new WalletService(makeSecrets());
  });

  describe('create()', () => {
    it('returns a mnemonic and wallet info', async () => {
      const { mnemonic, info } = await wallet.create({ name: 'Test', description: '' }, PASSWORD);
      expect(typeof mnemonic).toBe('string');
      expect(mnemonic.split(' ')).toHaveLength(12);
      expect(info.name).toBe('Test');
      expect(info.address).toBeTruthy();
      expect(info.publicKey).toBeTruthy();
      expect(info.id).toBeTruthy();
    });

    it('derives id from the first 16 chars of publicKey', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      expect(info.id).toBe(info.publicKey.slice(0, 16));
    });

    it('stores the wallet so list() returns it', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      const list = await wallet.list();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(info.id);
    });

    it('sets the first wallet as active', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      const active = await wallet.getActive();
      expect(active?.id).toBe(info.id);
    });

    it('does not change active when a second wallet is added', async () => {
      const { info: first } = await wallet.create({ name: 'First', description: '' }, PASSWORD);
      await wallet.create({ name: 'Second', description: '' }, PASSWORD);
      const active = await wallet.getActive();
      expect(active?.id).toBe(first.id);
    });

    it('fires onDidChange after creation', async () => {
      const changes: WalletChange[] = [];
      wallet.onDidChange(e => changes.push(e));
      await wallet.create({ name: 'W', description: '' }, PASSWORD);
      expect(changes).toHaveLength(1);
      expect(changes[0].wallets).toHaveLength(1);
    });
  });

  describe('import()', () => {
    it('imports a known mnemonic and returns consistent address', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      const info = await wallet.import(mnemonic, { name: 'Imported', description: '' }, PASSWORD);
      const info2 = await wallet.import(mnemonic, { name: 'Again', description: '' }, PASSWORD).catch(e => e);
      expect(info.address).toBeTruthy();
      // second import of same mnemonic should be rejected
      expect(info2).toBeInstanceOf(Error);
      expect((info2 as Error).message).toContain('already exists');
    });

    it('rejects an invalid mnemonic', async () => {
      await expect(
        wallet.import('not a valid mnemonic phrase at all', { name: 'Bad', description: '' }, PASSWORD)
      ).rejects.toThrow('Invalid mnemonic');
    });
  });

  describe('checkMnemonic()', () => {
    const KNOWN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    it('accepts a valid phrase that is not yet in the vault', async () => {
      const result = await wallet.checkMnemonic(KNOWN);
      expect(result.valid).toBe(true);
      expect(result.existing).toBeUndefined();
    });

    it('rejects an invalid phrase', async () => {
      const result = await wallet.checkMnemonic('not a valid mnemonic phrase at all');
      expect(result.valid).toBe(false);
      expect(result.existing).toBeUndefined();
    });

    it('flags a phrase already backing an imported wallet', async () => {
      const info = await wallet.import(KNOWN, { name: 'Treasury', description: '' }, PASSWORD);
      const result = await wallet.checkMnemonic(KNOWN);
      expect(result.valid).toBe(true);
      expect(result.existing?.id).toBe(info.id);
      expect(result.existing?.name).toBe('Treasury');
    });

    it('normalizes whitespace before validating', async () => {
      const result = await wallet.checkMnemonic(`  ${KNOWN.replace(/ /g, '   ')}  `);
      expect(result.valid).toBe(true);
    });
  });

  describe('reveal()', () => {
    it('returns the original mnemonic with the correct password', async () => {
      const { mnemonic, info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      const revealed = await wallet.reveal(info.id, PASSWORD);
      expect(revealed).toBe(mnemonic);
    });

    it('throws on wrong password', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      await expect(wallet.reveal(info.id, 'wrong-password')).rejects.toThrow('Incorrect password.');
    });

    it('throws when wallet id is not found', async () => {
      await expect(wallet.reveal('nonexistent', PASSWORD)).rejects.toThrow('Wallet not found');
    });
  });

  describe('reveal() rate limiting', () => {
    const WRONG = 'wrong-password';
    let nowOffset: number;

    beforeEach(() => {
      nowOffset = 0;
      const realNow = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + nowOffset);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const advance = (ms: number) => { nowOffset += ms; };

    async function failOnce(id: string): Promise<Error> {
      return wallet.reveal(id, WRONG).then(
        () => { throw new Error('expected reveal to fail'); },
        (err: Error) => err
      );
    }

    it('surfaces a plain error for the first four failures', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      for (let i = 0; i < 4; i++) {
        const err = await failOnce(info.id);
        expect(err.message).toBe('Incorrect password.');
      }
    });

    it('blocks for 8s on the fifth consecutive failure', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      for (let i = 0; i < 4; i++) await failOnce(info.id);
      const err = await failOnce(info.id);
      expect(err.message).toContain('Too many attempts');
      expect(err.message).toContain('wait 8s');
    });

    it('rejects even the correct password while blocked, without extending the block', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      for (let i = 0; i < 5; i++) await failOnce(info.id);
      await expect(wallet.reveal(info.id, PASSWORD)).rejects.toThrow(/Too many attempts/);
      advance(8_000);
      await expect(wallet.reveal(info.id, PASSWORD)).resolves.toBeTruthy();
    });

    it('doubles the block on each further failure and caps at 60s', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      for (let i = 0; i < 4; i++) await failOnce(info.id);
      for (const secs of [8, 16, 32, 60, 60]) {
        const err = await failOnce(info.id);
        expect(err.message).toContain(`wait ${secs}s`);
        advance(secs * 1000);
      }
    });

    it('resets the counter after a successful reveal', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      for (let i = 0; i < 4; i++) await failOnce(info.id);
      await wallet.reveal(info.id, PASSWORD);
      const err = await failOnce(info.id);
      expect(err.message).toBe('Incorrect password.');
    });

    it('forgets stale failures after the 10-minute decay window', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      for (let i = 0; i < 4; i++) await failOnce(info.id);
      advance(10 * 60_000 + 1);
      const err = await failOnce(info.id);
      expect(err.message).toBe('Incorrect password.');
    });

    it('tracks attempts per wallet id', async () => {
      const { info: a } = await wallet.create({ name: 'A', description: '' }, PASSWORD);
      const { info: b } = await wallet.create({ name: 'B', description: '' }, ALT_PASSWORD);
      for (let i = 0; i < 5; i++) await failOnce(a.id);
      const err = await failOnce(b.id);
      expect(err.message).toBe('Incorrect password.');
    });
  });

  describe('delete()', () => {
    it('removes the wallet from the list', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      await wallet.delete(info.id);
      expect(await wallet.list()).toHaveLength(0);
    });

    it('clears active when the active wallet is deleted', async () => {
      const { info } = await wallet.create({ name: 'W', description: '' }, PASSWORD);
      await wallet.delete(info.id);
      expect(await wallet.getActive()).toBeUndefined();
    });

    it('promotes next wallet to active when active is deleted', async () => {
      await wallet.create({ name: 'First', description: '' }, PASSWORD);
      const { info: second } = await wallet.create({ name: 'Second', description: '' }, PASSWORD);
      const active = await wallet.getActive();
      await wallet.delete(active!.id);
      expect((await wallet.getActive())?.id).toBe(second.id);
    });
  });

  describe('setActive()', () => {
    it('changes the active wallet', async () => {
      const { info: first } = await wallet.create({ name: 'First', description: '' }, PASSWORD);
      const { info: second } = await wallet.create({ name: 'Second', description: '' }, ALT_PASSWORD);
      await wallet.setActive(second.id);
      expect((await wallet.getActive())?.id).toBe(second.id);
      expect((await wallet.getActive())?.id).not.toBe(first.id);
    });

    it('throws for an unknown wallet id', async () => {
      await expect(wallet.setActive('nonexistent')).rejects.toThrow('Wallet not found');
    });
  });

  describe('updateMetadata()', () => {
    it('updates the wallet name', async () => {
      const { info } = await wallet.create({ name: 'Old', description: '' }, PASSWORD);
      const updated = await wallet.updateMetadata(info.id, { name: 'New Name' });
      expect(updated.name).toBe('New Name');
      expect((await wallet.list())[0].name).toBe('New Name');
    });

    it('throws for an unknown wallet id', async () => {
      await expect(wallet.updateMetadata('bad-id', { name: 'X' })).rejects.toThrow('Wallet not found');
    });
  });

  describe('count()', () => {
    it('returns 0 for a fresh vault', async () => {
      expect(await wallet.count()).toBe(0);
    });

    it('increments after each create', async () => {
      await wallet.create({ name: 'A', description: '' }, PASSWORD);
      await wallet.create({ name: 'B', description: '' }, PASSWORD);
      expect(await wallet.count()).toBe(2);
    });
  });
});
