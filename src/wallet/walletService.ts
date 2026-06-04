import * as vscode from 'vscode';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, mnemonicGenerate, mnemonicValidate } from '@polkadot/util-crypto';
import { encrypt, decrypt } from './crypto';
import type { EncryptedBlob } from './crypto';

const SECRETS_KEY = 'acurast.wallets.v2';
export const ACURAST_SS58_PREFIX = 42;

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
    const vault = await this.loadVault();
    const stored = vault.wallets.find((w) => w.info.id === id);
    if (!stored) throw new Error('Wallet not found');
    return decrypt(stored.encrypted, password);
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
