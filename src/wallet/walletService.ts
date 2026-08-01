import * as vscode from 'vscode';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, mnemonicGenerate, mnemonicValidate } from '@polkadot/util-crypto';
import { encrypt, decrypt } from './crypto';
import type { EncryptedBlob } from './crypto';

const SECRETS_KEY = 'acurast.wallets.v2';
export const ACURAST_SS58_PREFIX = 42;

interface AttemptState {
  count: number;
  lastAttempt: number;
  blockedUntil: number;
}

const MAX_ATTEMPTS = 5;
const BLOCK_AFTER = MAX_ATTEMPTS - 1;
const BASE_DELAY_MS = 500;
const COOLDOWN_MS = 60_000;
const ATTEMPT_DECAY_MS = 10 * 60_000;

export interface WalletInfo {
  id: string;
  address: string;
  publicKey: string;
  name: string;
  description: string;
}

export interface WalletMetadata {
  name: string;
  description: string;
}

interface StoredWallet {
  v: 1;
  info: WalletInfo;
  encrypted: EncryptedBlob;
}

interface Vault {
  v: 2;
  wallets: StoredWallet[];
  activeId: string | undefined;
}

export interface WalletChange {
  wallets: WalletInfo[];
  activeId: string | undefined;
}

export class WalletService {
  private _onDidChange = new vscode.EventEmitter<WalletChange>();
  readonly onDidChange = this._onDidChange.event;
  private _ready: Promise<void>;
  private _attempts = new Map<string, AttemptState>();

  constructor(private readonly secrets: vscode.SecretStorage) {
    this._ready = cryptoWaitReady().then(() => undefined);
  }

  async list(): Promise<WalletInfo[]> {
    const vault = await this.loadVault();
    return vault.wallets.map((w) => w.info);
  }

  async getActive(): Promise<WalletInfo | undefined> {
    const vault = await this.loadVault();
    if (!vault.activeId) return undefined;
    return vault.wallets.find((w) => w.info.id === vault.activeId)?.info;
  }

  async getActiveId(): Promise<string | undefined> {
    return (await this.loadVault()).activeId;
  }

  async setActive(id: string): Promise<void> {
    const vault = await this.loadVault();
    if (!vault.wallets.find((w) => w.info.id === id)) {
      throw new Error('Wallet not found');
    }
    vault.activeId = id;
    await this.saveVault(vault);
    await this.fireChange(vault);
  }

  async count(): Promise<number> {
    return (await this.loadVault()).wallets.length;
  }

  async create(metadata: WalletMetadata, password: string): Promise<{ mnemonic: string; info: WalletInfo }> {
    await this._ready;
    const mnemonic = mnemonicGenerate(12);
    const derived = this.derive(mnemonic);
    const info: WalletInfo = { id: this.makeId(derived.publicKey), ...derived, ...metadata };
    await this.addWallet(info, mnemonic, password);
    return { mnemonic, info };
  }

  async import(mnemonic: string, metadata: WalletMetadata, password: string): Promise<WalletInfo> {
    await this._ready;
    const trimmed = mnemonic.trim().replace(/\s+/g, ' ');
    if (!mnemonicValidate(trimmed)) {
      throw new Error('Invalid mnemonic phrase.');
    }
    const derived = this.derive(trimmed);
    const id = this.makeId(derived.publicKey);
    const vault = await this.loadVault();
    if (vault.wallets.find((w) => w.info.id === id)) {
      throw new Error('This wallet (same address) already exists.');
    }
    const info: WalletInfo = { id, ...derived, ...metadata };
    await this.addWallet(info, trimmed, password);
    return info;
  }

  /**
   * Inspect a pasted recovery phrase without importing it: confirm the BIP39
   * checksum and report whether a wallet with the same derived id already exists.
   * Powers the in-panel import flow's pre-advance validation (the webview already
   * does the cheap word-count check; this does the crypto the webview can't).
   */
  async checkMnemonic(mnemonic: string): Promise<{ valid: boolean; existing?: WalletInfo }> {
    await this._ready;
    const trimmed = mnemonic.trim().replace(/\s+/g, ' ');
    if (!mnemonicValidate(trimmed)) return { valid: false };
    const id = this.makeId(this.derive(trimmed).publicKey);
    const vault = await this.loadVault();
    const existing = vault.wallets.find((w) => w.info.id === id)?.info;
    return { valid: true, existing };
  }

  async updateMetadata(id: string, patch: Partial<WalletMetadata>): Promise<WalletInfo> {
    const vault = await this.loadVault();
    const idx = vault.wallets.findIndex((w) => w.info.id === id);
    if (idx === -1) throw new Error('Wallet not found');
    vault.wallets[idx].info = { ...vault.wallets[idx].info, ...patch };
    await this.saveVault(vault);
    await this.fireChange(vault);
    return vault.wallets[idx].info;
  }

  async reveal(id: string, password: string): Promise<string> {
    const now = Date.now();
    let state = this._attempts.get(id);
    // Failures older than the decay window no longer indicate active guessing.
    if (state && now - state.lastAttempt > ATTEMPT_DECAY_MS) {
      this._attempts.delete(id);
      state = undefined;
    }
    if (state && now < state.blockedUntil) {
      const remaining = Math.ceil((state.blockedUntil - now) / 1000);
      throw new Error(`Too many attempts. Please wait ${remaining}s before trying again.`);
    }

    const vault = await this.loadVault();
    const stored = vault.wallets.find((w) => w.info.id === id);
    if (!stored) throw new Error('Wallet not found');

    try {
      const result = decrypt(stored.encrypted, password);
      this._attempts.delete(id);
      return result;
    } catch (err) {
      const prev = this._attempts.get(id);
      const count = (prev?.count ?? 0) + 1;
      const delay = Math.min(BASE_DELAY_MS * 2 ** (count - 1), COOLDOWN_MS);
      const blockedUntil = count > BLOCK_AFTER ? now + delay : 0;
      this._attempts.set(id, { count, lastAttempt: now, blockedUntil });

      if (blockedUntil > 0) {
        const remaining = Math.ceil(delay / 1000);
        throw new Error(`Incorrect password. Too many attempts — please wait ${remaining}s before trying again.`);
      }
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    const vault = await this.loadVault();
    vault.wallets = vault.wallets.filter((w) => w.info.id !== id);
    if (vault.activeId === id) {
      vault.activeId = vault.wallets[0]?.info.id;
    }
    await this.saveVault(vault);
    await this.fireChange(vault);
  }

  async getInfo(id: string): Promise<WalletInfo | undefined> {
    const vault = await this.loadVault();
    return vault.wallets.find((w) => w.info.id === id)?.info;
  }

  private async addWallet(info: WalletInfo, mnemonic: string, password: string): Promise<void> {
    const vault = await this.loadVault();
    vault.wallets.push({ v: 1, info, encrypted: encrypt(mnemonic, password) });
    if (!vault.activeId) vault.activeId = info.id;
    await this.saveVault(vault);
    await this.fireChange(vault);
  }

  private async fireChange(vault: Vault): Promise<void> {
    this._onDidChange.fire({
      wallets: vault.wallets.map((w) => w.info),
      activeId: vault.activeId,
    });
  }

  private async loadVault(): Promise<Vault> {
    const raw = await this.secrets.get(SECRETS_KEY);
    if (!raw) return { v: 2, wallets: [], activeId: undefined };
    try {
      const parsed = JSON.parse(raw) as Vault;
      if (parsed.v !== 2) return { v: 2, wallets: [], activeId: undefined };
      return parsed;
    } catch {
      return { v: 2, wallets: [], activeId: undefined };
    }
  }

  private async saveVault(vault: Vault): Promise<void> {
    await this.secrets.store(SECRETS_KEY, JSON.stringify(vault));
  }

  private derive(mnemonic: string): Pick<WalletInfo, 'address' | 'publicKey'> {
    const keyring = new Keyring({ type: 'sr25519', ss58Format: ACURAST_SS58_PREFIX });
    const pair = keyring.addFromMnemonic(mnemonic);
    return {
      address: pair.address,
      publicKey: Buffer.from(pair.publicKey).toString('hex'),
    };
  }

  private makeId(publicKey: string): string {
    return publicKey.slice(0, 16);
  }
}
