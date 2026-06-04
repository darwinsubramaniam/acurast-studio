import { AcurastService, getBalance, getHumanReadableVersion, fetchDeviceVersions } from '@acurast/sdk/chain';
import type { KeyringPair } from '@polkadot/keyring/types';
import { RPC_ENDPOINTS, type AcurastNetwork } from './constants';
import type { ManagedProcessor, ManagedProcessorsResult, JobDiagnosis, DiagnosisCheck } from '../studio/types';

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

    const tx = (api.tx as any).acurastProcessorManager.advertiseFor(processor, advertisement);
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
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

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
    if (!this.deviceVersionsLoaded) {
      try { await fetchDeviceVersions(); } catch { /* bundled versions */ }
      this.deviceVersionsLoaded = true;
    }

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

    // Decode registration. reward/version/reputation live under extra.requirements.
    const sched = reg.schedule ?? {};
    const reqs = reg.extra?.requirements ?? {};
    const startTime = Number(sched.startTime ?? 0);
    const maxStartDelay = Number(sched.maxStartDelay ?? 0);
    const duration = Number(sched.duration ?? 0);
    const reqModules: string[] = (reg.requiredModules ?? []).map((m: any) => String(m));
    const allowed: string[] = (reg.allowedSources ?? []).map((s: any) => String(s));
    const reward = BigInt(reqs.reward ?? 0);
    const storage = Number(reg.storage ?? 0);
    const memory = Number(reg.memory ?? 0);
    const minRep = reqs.minReputation != null ? Number(reqs.minReputation) : null;
    const minVer: any[] = reqs.processorVersion?.min ?? [];
    const strat = reqs.assignmentStrategy ?? {};
    const isCompeting = strat.competing !== undefined;
    const isInstant = !isCompeting && Array.isArray(strat.single) && strat.single.length > 0;

    // ── Job-level checks ──
    const now = Date.now();
    const windowEnd = startTime + maxStartDelay;
    if (result.jobStatus === 'assigned') {
      result.checks.push({ id: 'startWindow', label: 'Start window', status: 'pass', detail: 'Job is already assigned.' });
    } else if (now <= windowEnd) {
      result.checks.push({ id: 'startWindow', label: 'Start window', status: 'pass', detail: `Open for ~${Math.round((windowEnd - now) / 1000)}s more (until startTime + maxStartDelay).` });
    } else {
      result.checks.push({ id: 'startWindow', label: 'Start window', status: 'fail', detail: `Closed ${Math.round((now - windowEnd) / 1000)}s ago. A job can't be assigned past startTime + maxStartDelay — increase Max start delay and redeploy.` });
    }
    result.checks.push({
      id: 'assignment', label: 'Assignment', status: 'info',
      detail: isInstant ? 'Instant match — targets specific processor(s) directly (fastest).'
        : isCompeting ? 'Competing — new processors per execution via the open matcher.'
        : 'Single, open matcher — relies on the network matcher within the start window. Use Instant Match to target a known processor.',
    });

    // ── Per-processor checks (whitelist) ──
    if (!allowed.length) {
      result.checks.push({ id: 'whitelist', label: 'Whitelist', status: 'info', detail: 'Public job (no processor whitelist) — eligibility can only be checked against specific processors.' });
    }
    const mp = q.acurastMarketplace;
    const pm = q.acurastProcessorManager;
    for (const p of allowed) {
      const checks: DiagnosisCheck[] = [];
      const restr = (await mp.storedAdvertisementRestriction(p))?.toJSON?.() as any;
      if (!restr) {
        result.processors.push({ address: p, eligible: false, checks: [{ id: 'ad', label: 'Advertisement', status: 'fail', detail: 'No marketplace advertisement — this processor is not advertising and cannot match anything.' }] });
        continue;
      }
      const price = (await mp.storedAdvertisementPricing(p))?.toJSON?.() as any;
      const ver = (await pm.processorVersion(p))?.toJSON?.() as any;
      const rep = (await mp.storedReputation(p))?.toJSON?.() as any;
      const hbRaw = (await pm.processorHeartbeat(p))?.toJSON?.();
      const hb = hbRaw != null ? Number(hbRaw) : null;

      const avail: string[] = (restr.availableModules ?? []).map((m: any) => String(m));
      const consumers: string[] = (restr.allowedConsumers ?? []).map((c: any) => typeof c === 'string' ? c : (c?.acurast ?? c?.Acurast ?? JSON.stringify(c)));

      const modulesOk = reqModules.every((m) => avail.includes(m));
      checks.push({ id: 'modules', label: 'Modules', status: modulesOk ? 'pass' : 'fail', detail: `requires [${reqModules.join(', ') || '—'}], advertises [${avail.join(', ') || '—'}]` });

      const privateOk = !consumers.length || consumers.includes(origin);
      checks.push({ id: 'consumers', label: 'Consumer access', status: privateOk ? 'pass' : 'fail', detail: consumers.length ? (privateOk ? 'deployer is in the processor\'s allowedConsumers (private ad).' : 'private ad — deployer is NOT in allowedConsumers.') : 'public ad — open to any consumer.' });

      let feeOk = true;
      if (price) {
        const fee = BigInt(price.baseFeePerExecution ?? 0) + BigInt(price.feePerMillisecond ?? 0) * BigInt(duration) + BigInt(price.feePerStorageByte ?? 0) * BigInt(storage);
        feeOk = fee <= reward;
        checks.push({ id: 'fee', label: 'Fee vs reward', status: feeOk ? 'pass' : 'fail', detail: `ad fee ${fee} planck ${feeOk ? '≤' : '>'} reward ${reward} planck (base + perMs×duration + perByte×storage). ${feeOk ? '' : 'Raise Max cost per execution.'}`.trim() });
      } else {
        checks.push({ id: 'fee', label: 'Fee vs reward', status: 'info', detail: 'processor has no pricing entry.' });
      }

      let versionOk = true;
      if (minVer.length) {
        const m = minVer.find((x: any) => Number(x.platform) === Number(ver?.platform)) ?? minVer[0];
        versionOk = ver != null && Number(ver.buildNumber) >= Number(m.buildNumber);
        const human = ver ? getHumanReadableVersion(ver) : '?';
        checks.push({ id: 'version', label: 'Version', status: versionOk ? 'pass' : 'fail', detail: `processor build ${ver?.buildNumber ?? '?'} (${human}) ${versionOk ? '≥' : '<'} min build ${m.buildNumber}` });
      } else {
        checks.push({ id: 'version', label: 'Version', status: 'info', detail: `processor build ${ver?.buildNumber ?? '?'} — no minimum required.` });
      }

      if (minRep != null) {
        checks.push({ id: 'reputation', label: 'Reputation', status: 'warn', detail: `min reputation ${minRep} required; processor r/s = ${rep?.r ?? 0}/${rep?.s ?? 0} (verify on the matcher).` });
      }

      const resOk = (restr.maxMemory == null || memory <= Number(restr.maxMemory)) && (restr.storageCapacity == null || storage <= Number(restr.storageCapacity));
      checks.push({ id: 'resources', label: 'Resources', status: resOk ? 'pass' : 'fail', detail: `job memory ${memory}/${restr.maxMemory ?? '∞'}, storage ${storage}/${restr.storageCapacity ?? '∞'}` });

      if (hb != null) {
        const ageS = Math.round((now - hb) / 1000);
        checks.push({ id: 'heartbeat', label: 'Liveness', status: ageS < 600 ? 'pass' : 'warn', detail: `last heartbeat ${ageS}s ago${ageS < 600 ? ' (online)' : ' — processor may be offline; it must be online during the start window'}.` });
      } else {
        checks.push({ id: 'heartbeat', label: 'Liveness', status: 'warn', detail: 'no heartbeat recorded — processor may never have come online.' });
      }

      const eligible = modulesOk && privateOk && feeOk && versionOk && resOk;
      result.processors.push({ address: p, eligible, checks });
    }

    // ── Overall verdict ──
    const eligibleCount = result.processors.filter((p) => p.eligible).length;
    const startClosed = result.checks.find((c) => c.id === 'startWindow')?.status === 'fail';
    if (result.jobStatus === 'assigned') {
      result.summary = `Matched ✓${assignedSlots != null ? ` — assigned to ${assignedSlots} slot(s)` : ''}.`;
    } else if (allowed.length && eligibleCount === 0) {
      result.summary = 'Unmatched — no whitelisted processor passes every requirement. Fix the failed checks below.';
    } else if (startClosed) {
      result.summary = 'Unmatched — the start window has closed; the job can no longer be assigned. Widen Max start delay and redeploy.';
    } else if (!allowed.length) {
      result.summary = 'Unmatched — public job waiting on the open matcher. Whitelist a processor (or use Instant Match) to diagnose eligibility.';
    } else {
      result.summary = 'Eligible but unmatched — the matcher likely hasn\'t assigned it yet. Use Instant Match and a wider start window to improve odds.';
    }
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
