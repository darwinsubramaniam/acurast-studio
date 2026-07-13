import { AcurastService, getBalance, getHumanReadableVersion, fetchDeviceVersions } from '@acurast/sdk/chain';
import type { KeyringPair } from '@polkadot/keyring/types';
import { RPC_ENDPOINTS, type AcurastNetwork } from './constants';
import type { ManagedProcessor, ManagedProcessorsResult, JobDiagnosis, NewAdvertisementParams } from '../studio/types';
import { deriveJobRequirements, isExpired, buildJobChecks, buildProcessorChecks, computeSummary } from '../lib/diagnosis';

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
  private deviceVersionsPromise: Promise<void> | undefined;

  /**
   * Populate the SDK's module-level device-version table exactly once.
   * Concurrent callers share a single in-flight fetch; best-effort, so a failed
   * fetch resolves quietly and falls back to the bundled version table.
   */
  private ensureDeviceVersions(): Promise<void> {
    return (this.deviceVersionsPromise ??= fetchDeviceVersions().then(() => {}).catch(() => {}));
  }

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

    await this.ensureDeviceVersions();

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

  /**
   * Prepares (but does not submit) an `acurastProcessorManager.advertiseFor`
   * extrinsic that re-publishes a managed processor's marketplace advertisement
   * with a new `availableModules` set. Every other field (pricing, memory,
   * storage, allowed consumers) is read back from chain and preserved verbatim,
   * so only the module list changes.
   *
   * Returns the exact, human-readable extrinsic args for a confirm-before-sign
   * preview, plus a `submit(signer)` closure that signs and sends the SAME tx
   * and resolves with the tx hash once in a block (rejecting with the decoded
   * module error on failure).
   *
   * Requires the processor to already have an advertisement — advertiseFor
   * upserts the whole struct, and we can only reconstruct it from an existing
   * pricing entry. Processors that have never advertised must start from the app.
   */
  async prepareAdvertiseModules(
    network: AcurastNetwork,
    processor: string,
    modules: string[],
  ): Promise<{
    preview: { section: string; method: string; args: unknown };
    submit: (signer: KeyringPair) => Promise<string>;
  }> {
    const svc = await this.service(network);
    const api = svc.api;
    if (!api) throw new Error('SDK service has no api after connect');

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const mp = (api.query as any).acurastMarketplace;
    const restrOpt: any = await mp.storedAdvertisementRestriction(processor);
    const priceOpt: any = await mp.storedAdvertisementPricing(processor);

    const hasRestr = restrOpt && (restrOpt.isSome ?? restrOpt.toJSON() != null);
    const hasPrice = priceOpt && (priceOpt.isSome ?? priceOpt.toJSON() != null);
    if (!hasRestr || !hasPrice) {
      throw new Error(
        'This processor has no marketplace advertisement to update. Start advertising from the Acurast app first.',
      );
    }

    const restr = typeof restrOpt.unwrap === 'function' ? restrOpt.unwrap() : restrOpt;
    const price = typeof priceOpt.unwrap === 'function' ? priceOpt.unwrap() : priceOpt;

    // Pass the existing codec values straight through so pricing/consumers are
    // re-encoded exactly as stored; only availableModules is swapped.
    const advertisement = {
      pricing: price,
      maxMemory: restr.maxMemory,
      networkRequestQuota: restr.networkRequestQuota,
      storageCapacity: restr.storageCapacity,
      allowedConsumers: restr.allowedConsumers,
      availableModules: modules,
    };

    return this.buildAdvertiseFor(api, processor, advertisement);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  /**
   * Prepares an `advertiseFor` extrinsic that publishes a brand-new
   * advertisement for a processor that has never advertised (the Studio
   * "Start advertising" flow). All values come from the caller since there is
   * no chain state to copy; the advertisement is public (allowedConsumers =
   * null). Refuses to run when an advertisement already exists so stale form
   * values can never clobber pricing the device itself published meanwhile.
   */
  async prepareStartAdvertising(
    network: AcurastNetwork,
    processor: string,
    modules: string[],
    params: NewAdvertisementParams,
  ): Promise<{
    preview: { section: string; method: string; args: unknown };
    submit: (signer: KeyringPair) => Promise<string>;
  }> {
    const svc = await this.service(network);
    const api = svc.api;
    if (!api) throw new Error('SDK service has no api after connect');

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const mp = (api.query as any).acurastMarketplace;
    const restrOpt: any = await mp.storedAdvertisementRestriction(processor);
    const priceOpt: any = await mp.storedAdvertisementPricing(processor);

    const hasRestr = restrOpt && (restrOpt.isSome ?? restrOpt.toJSON() != null);
    const hasPrice = priceOpt && (priceOpt.isSome ?? priceOpt.toJSON() != null);
    if (hasRestr || hasPrice) {
      throw new Error(
        'This processor is already advertising. Refresh the Processors view and edit its modules instead.',
      );
    }

    const advertisement = {
      pricing: {
        feePerMillisecond: params.feePerMillisecond,
        feePerStorageByte: params.feePerStorageByte,
        baseFeePerExecution: params.baseFeePerExecution,
        schedulingWindow: { end: params.schedulingWindowEnd },
      },
      maxMemory: params.maxMemory,
      networkRequestQuota: params.networkRequestQuota,
      storageCapacity: params.storageCapacity,
      allowedConsumers: null,
      availableModules: modules,
    };

    return this.buildAdvertiseFor(api, processor, advertisement);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  /**
   * Wraps an `advertiseFor` call as a human-readable preview (toHuman() of the
   * exact call that gets signed) plus a `submit(signer)` closure that signs and
   * sends that SAME tx, resolving with the tx hash once in a block and
   * rejecting with the decoded module error on failure.
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private buildAdvertiseFor(
    api: any,
    processor: string,
    advertisement: unknown,
  ): {
    preview: { section: string; method: string; args: unknown };
    submit: (signer: KeyringPair) => Promise<string>;
  } {
    const tx = api.tx.acurastProcessorManager.advertiseFor(processor, advertisement);
    // toHuman() of the call is exactly what gets signed — the faithful preview.
    const human = tx.method.toHuman() as { section: string; method: string; args: unknown };

    const submit = (signer: KeyringPair): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        let unsub: (() => void) | undefined;
        tx.signAndSend(signer, (result: any) => {
          const { status, dispatchError, txHash } = result;
          if (dispatchError) {
            let msg: string;
            if (dispatchError.isModule) {
              const decoded = api.registry.findMetaError(dispatchError.asModule);
              msg = `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`.trim();
            } else {
              msg = dispatchError.toString();
            }
            if (unsub) unsub();
            reject(new Error(msg));
            return;
          }
          if (status.isInBlock || status.isFinalized) {
            if (unsub) unsub();
            resolve(txHash.toString());
          }
        }).then((u: () => void) => { unsub = u; }).catch(reject);
      });

    return { preview: { section: human.section, method: human.method, args: human.args }, submit };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /**
   * Explains why an on-chain job is / isn't matching by evaluating every gate the
   * Acurast marketplace enforces against each whitelisted processor's live
   * advertisement: required modules ⊆ availableModules, whitelist/allowedConsumers,
   * advertised fee ≤ reward, processor version ≥ min, resource limits, start
   * window (startTime + maxStartDelay), and heartbeat liveness. Read-only.
   */
  async diagnoseJob(network: AcurastNetwork, origin: string, localId: number): Promise<JobDiagnosis> {
    const svc = await this.service(network);
    const api = svc.api;
    if (!api) throw new Error('SDK service has no api after connect');
    await this.ensureDeviceVersions();

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const q = api.query as any;
    const multiOrigin = (api as any).createType('AcurastCommonMultiOrigin', { acurast: origin });
    const result: JobDiagnosis = {
      found: false, origin, localId, network, jobStatus: 'unknown', summary: '', checks: [], processors: [],
    };

    // Locate the registration for this localId (partial-key query for this origin).
    const entries: [any, any][] = await q.acurast.storedJobRegistration.entries(multiOrigin);
    let reg: any = null;
    for (const [key, val] of entries) {
      if ((api as any).createType('u128', key.args.at(1)).toNumber() !== localId) continue;
      try { reg = (api as any).createType('Option<AcurastCommonJobRegistration>', val).unwrap().toJSON(); } catch { /* codec mismatch */ }
      break;
    }
    if (!reg) {
      result.summary = `No on-chain registration found for job ${localId} under this wallet.`;
      return result;
    }
    result.found = true;

    // Match status.
    let assignedSlots: number | undefined;
    try {
      const st = (await q.acurastMarketplace.storedJobStatus(multiOrigin, localId))?.toJSON?.() as any;
      if (st && typeof st === 'object') {
        if ('open' in st) result.jobStatus = 'open';
        else { result.jobStatus = 'assigned'; const a = st.assigned; assignedSlots = typeof a === 'number' ? a : (typeof a?.slots === 'number' ? a.slots : undefined); result.assignedSlots = assignedSlots; }
      }
    } catch { /* no status */ }

    // Decode the registration into the flat requirement set the checks need; the
    // reasoning itself lives in the pure `../lib/diagnosis` module.
    const reqsFlat = deriveJobRequirements(reg);
    const now = Date.now();
    const expired = isExpired(reqsFlat.endTime, now);
    result.expired = expired;
    if (reqsFlat.endTime > 0) result.endTime = reqsFlat.endTime;

    // ── Job-level checks ──
    result.checks = buildJobChecks({
      jobStatus: result.jobStatus,
      expired,
      now,
      startTime: reqsFlat.startTime,
      maxStartDelay: reqsFlat.maxStartDelay,
      endTime: reqsFlat.endTime,
      isInstant: reqsFlat.isInstant,
      isCompeting: reqsFlat.isCompeting,
      allowed: reqsFlat.allowed,
    });

    // ── Per-processor checks (whitelist) ── I/O here, the gating logic in the module.
    const mp = q.acurastMarketplace;
    const pm = q.acurastProcessorManager;
    const allowed = reqsFlat.allowed;
    if (allowed.length) {
      // Batch each per-processor read into one multi() call (mirrors
      // getManagedProcessors) instead of 5 sequential RPCs per processor.
      const [restrs, prices, vers, reps, hbsRaw] = await Promise.all([
        mp.storedAdvertisementRestriction.multi(allowed),
        mp.storedAdvertisementPricing.multi(allowed),
        pm.processorVersion.multi(allowed),
        mp.storedReputation.multi(allowed),
        pm.processorHeartbeat.multi(allowed),
      ]);
      allowed.forEach((p: any, i: number) => {
        const restr = restrs[i]?.toJSON?.() as any;
        // Only surface price/version/reputation/heartbeat when an advertisement
        // restriction exists for the processor (preserves prior semantics).
        const price = restr ? (prices[i]?.toJSON?.() as any) : null;
        const ver = restr ? (vers[i]?.toJSON?.() as any) : null;
        const rep = restr ? (reps[i]?.toJSON?.() as any) : null;
        const hbRaw = restr ? hbsRaw[i]?.toJSON?.() : null;
        const hb = hbRaw != null ? Number(hbRaw) : null;
        result.processors.push(buildProcessorChecks({
          address: p, restr, price, ver, rep, hb, now,
          reqModules: reqsFlat.reqModules, origin,
          duration: reqsFlat.duration, storage: reqsFlat.storage, memory: reqsFlat.memory,
          reward: reqsFlat.reward, minVer: reqsFlat.minVer, minRep: reqsFlat.minRep,
        }));
      });
    }

    // ── Overall verdict ──
    const startClosed = result.checks.find((c) => c.id === 'startWindow')?.status === 'fail';
    result.summary = computeSummary({
      jobStatus: result.jobStatus,
      expired,
      now,
      endTime: reqsFlat.endTime,
      assignedSlots,
      allowed: reqsFlat.allowed,
      processors: result.processors,
      startClosed,
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return result;
  }

  async dispose() {
    for (const svc of this.services.values()) {
      try { await svc.disconnect(); } catch { /* ignore */ }
    }
    this.services.clear();
  }
}

export const acurastClient = new AcurastClient();
