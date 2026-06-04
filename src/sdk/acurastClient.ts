import { AcurastService, getBalance, getHumanReadableVersion, fetchDeviceVersions } from '@acurast/sdk/chain';
import { RPC_ENDPOINTS, type AcurastNetwork } from './constants';
import type { ManagedProcessor, ManagedProcessorsResult } from '../studio/types';

type RpcOverrides = Partial<Record<AcurastNetwork, string>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toNum(v: any): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export class AcurastClient {
  private getOverrides: () => RpcOverrides = () => ({});
  private services = new Map<AcurastNetwork, AcurastService>();
  private deviceVersionsLoaded = false;

  configure(getOverrides: () => RpcOverrides): void {
    this.getOverrides = getOverrides;
  }

  private getRpc(network: AcurastNetwork): string {
    return this.getOverrides()[network] ?? RPC_ENDPOINTS[network];
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

  /**
   * Lists every processor device managed by `address`. A wallet manages
   * processors through manager NFTs in the `uniques` pallet — and may hold
   * those NFTs in either uniques collection — so we enumerate all NFTs the
   * wallet owns and union the processors under each. NFTs that aren't managers
   * resolve to an empty `managedProcessors` set and drop out naturally.
   */
  async getManagedProcessors(network: AcurastNetwork, address: string): Promise<ManagedProcessorsResult> {
    const svc = await this.service(network);
    const api = svc.api;
    if (!api) throw new Error('SDK service has no api after connect');

    if (!this.deviceVersionsLoaded) {
      // Populates the SDK's module-level version table so build numbers map to
      // version strings. Best-effort: falls back to the bundled table offline.
      try { await fetchDeviceVersions(); } catch { /* use bundled versions */ }
      this.deviceVersionsLoaded = true;
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const pm = (api.query as any).acurastProcessorManager;
    const mp = (api.query as any).acurastMarketplace;

    // Candidate managerIds = item ids of every NFT the wallet owns.
    const owned: [any, any][] = await (api.query as any).uniques.account.entries(address);
    const candidateIds = owned.map(([key]) => key.args[2]); // [account, collectionId, itemId]

    // processor address -> managerId it was first seen under
    const procToManager = new Map<string, string>();
    const managerIds: string[] = [];
    for (const managerId of candidateIds) {
      const entries: [any, any][] = await pm.managedProcessors.entries(managerId);
      if (!entries.length) continue;
      managerIds.push(managerId.toString());
      for (const [key] of entries) {
        const proc = key.args[1].toString();
        if (!procToManager.has(proc)) procToManager.set(proc, managerId.toString());
      }
    }

    const addrs = [...procToManager.keys()];
    if (!addrs.length) return { managerIds, processors: [] };

    // Batch every per-processor read into one multi() call each.
    const [heartbeats, versions, reputations, ads, pricings] = await Promise.all([
      pm.processorHeartbeat.multi(addrs),
      pm.processorVersion.multi(addrs),
      mp.storedReputation.multi(addrs),
      mp.storedAdvertisementRestriction.multi(addrs),
      mp.storedAdvertisementPricing.multi(addrs),
    ]);

    const processors: ManagedProcessor[] = addrs.map((addr, i) => {
      const verJson = versions[i]?.toJSON() as any;
      const adJson = ads[i]?.toJSON() as any;
      const prJson = pricings[i]?.toJSON() as any;
      const repJson = reputations[i]?.toJSON() as any;

      let version: string | undefined;
      try { if (verJson) version = getHumanReadableVersion(verJson); } catch { /* unknown build */ }

      return {
        address: addr,
        managerId: procToManager.get(addr) as string,
        lastSeen: toNum(heartbeats[i]?.toString()) ?? 0,
        version,
        platform: toNum(verJson?.platform),
        reputation: repJson ? { r: toNum(repJson.r) ?? 0, s: toNum(repJson.s) ?? 0 } : undefined,
        advertising: !!adJson,
        ad: adJson ? {
          maxMemory: toNum(adJson.maxMemory),
          networkRequestQuota: toNum(adJson.networkRequestQuota),
          storageCapacity: toNum(adJson.storageCapacity),
          availableModules: Array.isArray(adJson.availableModules) ? adJson.availableModules.map(String) : [],
          allowedConsumers: Array.isArray(adJson.allowedConsumers)
            ? adJson.allowedConsumers.map((c: any) => c?.acurast ?? c?.tezos ?? JSON.stringify(c))
            : null,
        } : undefined,
        pricing: prJson ? {
          feePerMillisecond: prJson.feePerMillisecond != null ? String(prJson.feePerMillisecond) : undefined,
          feePerStorageByte: prJson.feePerStorageByte != null ? String(prJson.feePerStorageByte) : undefined,
          baseFeePerExecution: prJson.baseFeePerExecution != null ? String(prJson.baseFeePerExecution) : undefined,
          schedulingWindowEnd: toNum(prJson.schedulingWindow?.end),
        } : undefined,
      };
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */

    return { managerIds, processors };
  }

  async dispose() {
    for (const svc of this.services.values()) {
      try { await svc.disconnect(); } catch { /* ignore */ }
    }
    this.services.clear();
  }
}

export const acurastClient = new AcurastClient();
