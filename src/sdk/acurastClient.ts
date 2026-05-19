import * as vscode from 'vscode';
import { AcurastService, getBalance } from '@acurast/sdk/chain';
import { RPC_ENDPOINTS, type AcurastNetwork } from './constants';

class AcurastClient {
  private services = new Map<AcurastNetwork, AcurastService>();

  private getRpc(network: AcurastNetwork): string {
    const overrides = vscode.workspace.getConfiguration('acurast').get<Partial<Record<AcurastNetwork, string>>>('rpcOverrides') ?? {};
    return overrides[network] ?? RPC_ENDPOINTS[network];
  }

  async service(network: AcurastNetwork): Promise<AcurastService> {
    let svc = this.services.get(network);
    if (!svc) {
      svc = new AcurastService(this.getRpc(network));
      this.services.set(network, svc);
    }
    await svc.connect();
    return svc;
  }

  async getBalance(network: AcurastNetwork, address: string): Promise<number> {
    const svc = await this.service(network);
    if (!svc.api) throw new Error('SDK service has no api after connect');
    return getBalance(svc.api, address);
  }

  async dispose() {
    for (const svc of this.services.values()) {
      try { await svc.disconnect(); } catch { /* ignore */ }
    }
    this.services.clear();
  }
}

export const acurastClient = new AcurastClient();
