// Diagnose why an Acurast job won't match.
// Usage: node scripts/diagnose-job.mjs <deployerAddress> <localId> [canary|mainnet]
//   node scripts/diagnose-job.mjs 5FcZ...KTsJ 378342 canary
//
// Reports the job's on-chain status (open vs assigned), its registration
// fields, and evaluates every matching constraint against each whitelisted
// processor's advertisement — so you can see exactly which gate fails.

import { AcurastService, getHumanReadableVersion, fetchDeviceVersions } from '@acurast/sdk/chain';

const RPC = {
  canary: 'wss://public-rpc.canary.acurast.com',
  mainnet: 'wss://public-rpc.mainnet.acurast.com',
};

const [, , deployer, localIdArg, networkArg = 'canary'] = process.argv;
if (!deployer || !localIdArg) {
  console.error('Usage: node scripts/diagnose-job.mjs <deployerAddress> <localId> [canary|mainnet]');
  process.exit(1);
}
const network = networkArg in RPC ? networkArg : 'canary';
const wantLocalId = BigInt(localIdArg);

const ok = (b) => (b ? '✅ PASS' : '❌ FAIL');
const j = (v) => JSON.stringify(v);

const svc = new AcurastService(RPC[network]);
await svc.connect();
const api = svc.api;
try { await fetchDeviceVersions(); } catch { /* bundled fallback */ }

const origin = api.createType('AcurastCommonMultiOrigin', { acurast: deployer });

// --- locate the job registration -------------------------------------------
const entries = await api.query.acurast.storedJobRegistration.entries(origin);
let reg = null;
for (const [key, val] of entries) {
  const lid = api.createType('u128', key.args.at(1)).toBigInt();
  if (lid === wantLocalId) {
    reg = api.createType('Option<AcurastCommonJobRegistration>', val).unwrap().toJSON();
    break;
  }
}

console.log(`\n=== Job ${wantLocalId} on ${network} (deployer ${deployer}) ===`);
if (process.env.RAW && reg) console.log(`\n[RAW registration]\n${JSON.stringify(reg, null, 2)}\n`);
if (!reg) {
  console.log(`No storedJobRegistration found for localId ${wantLocalId} under this deployer.`);
  console.log(`Deployer has ${entries.length} job(s). localIds: ${entries.map(([k]) => api.createType('u128', k.args.at(1)).toString()).join(', ')}`);
  await svc.disconnect();
  process.exit(0);
}

// --- status ----------------------------------------------------------------
const statusOpt = await api.query.acurastMarketplace.storedJobStatus(origin, wantLocalId.toString());
const status = statusOpt?.toJSON?.() ?? statusOpt;
console.log(`\nstoredJobStatus: ${j(status)}   ${status && 'open' in status ? '→ UNMATCHED (open)' : status ? '→ matched/assigned' : '→ none'}`);

// --- registration fields ---------------------------------------------------
const sched = reg.schedule ?? {};
const now = Date.now();
const startTime = Number(sched.startTime);
const endTime = Number(sched.endTime);
const maxStartDelay = Number(sched.maxStartDelay ?? 0);
const duration = Number(sched.duration ?? 0);
const interval = Number(sched.interval ?? 0);
// Reward / reputation / version requirements live under extra.requirements.
const reqs = reg.extra?.requirements ?? {};
const reqModules = reg.requiredModules ?? [];
const allowed = (reg.allowedSources ?? []).map(String);
const reward = BigInt(reqs.reward ?? reg.reward ?? 0);
const storage = Number(reg.storage ?? 0);
const memory = Number(reg.memory ?? 0);
const minRep = reqs.minReputation != null ? Number(reqs.minReputation) : null;
const minVer = reqs.processorVersion?.min ?? null;

console.log(`\n--- registration ---`);
console.log(`requiredModules : ${j(reqModules)}`);
console.log(`allowedSources  : ${allowed.length ? j(allowed) : '(public — any processor)'}`);
console.log(`reward          : ${reward}`);
console.log(`storage / memory: ${storage} / ${memory}`);
console.log(`minReputation   : ${minRep ?? '(none)'}`);
console.log(`processorVer.min: ${j(minVer)}`);
console.log(`schedule        : start=${new Date(startTime).toISOString()} end=${new Date(endTime).toISOString()}`);
console.log(`                  duration=${duration}ms interval=${interval}ms maxStartDelay=${maxStartDelay}ms`);

// --- the timing gate (the usual culprit for onetime Shell) -----------------
const windowEnd = startTime + maxStartDelay;
const secsLeft = Math.round((windowEnd - now) / 1000);
console.log(`\n--- start window ---`);
console.log(`startTime + maxStartDelay = ${new Date(windowEnd).toISOString()}`);
console.log(`now                       = ${new Date(now).toISOString()}`);
console.log(`${ok(now <= windowEnd)}  start window ${now <= windowEnd ? `still open (${secsLeft}s left)` : `CLOSED ${-secsLeft}s ago — job can never be assigned now`}`);

// --- per-processor eligibility ---------------------------------------------
const targets = allowed.length ? allowed : [];
if (!targets.length) {
  console.log(`\n(Public job — no whitelist to check. If still open, it's matcher coverage or the timing/fee gate.)`);
} else {
  const mp = api.query.acurastMarketplace;
  const pm = api.query.acurastProcessorManager;
  for (const p of targets) {
    console.log(`\n--- processor ${p} ---`);
    const restrOpt = await mp.storedAdvertisementRestriction(p);
    const priceOpt = await mp.storedAdvertisementPricing(p);
    const restr = restrOpt?.toJSON?.() ?? null;
    const price = priceOpt?.toJSON?.() ?? null;
    if (!restr) { console.log(`  ❌ no advertisement (not advertising) — cannot match anything`); continue; }

    const avail = (restr.availableModules ?? []).map(String);
    // allowedConsumers are MultiOrigin objects: { acurast: '5...' } — extract the address.
    const consumers = (restr.allowedConsumers ?? []).map((c) =>
      typeof c === 'string' ? c : (c?.acurast ?? c?.Acurast ?? JSON.stringify(c))
    );
    const verOpt = await pm.processorVersion(p);
    const ver = verOpt?.toJSON?.() ?? null;
    const hbOpt = await pm.processorHeartbeat(p);
    const hb = hbOpt && hbOpt.toJSON ? Number(hbOpt.toJSON()) : null;
    const repOpt = await mp.storedReputation(p);
    const rep = repOpt?.toJSON?.() ?? null;

    const modulesOk = reqModules.every((m) => avail.includes(m));
    const privateOk = !consumers.length || consumers.includes(deployer);
    let feeOk = '(no pricing)';
    if (price) {
      const base = BigInt(price.baseFeePerExecution ?? 0);
      const perMs = BigInt(price.feePerMillisecond ?? 0);
      const perByte = BigInt(price.feePerStorageByte ?? 0);
      const fee = base + perMs * BigInt(duration) + perByte * BigInt(storage);
      feeOk = `${ok(fee <= reward)}  adFee=${fee} ≤ reward=${reward}  (base=${base} + perMs=${perMs}*${duration}ms + perByte=${perByte}*${storage})`;
    }

    console.log(`  availableModules: ${j(avail)}`);
    console.log(`  ${ok(modulesOk)}  requiredModules ⊆ availableModules`);
    console.log(`  allowedConsumers: ${consumers.length ? j(consumers) : '(public ad)'}`);
    console.log(`  ${ok(privateOk)}  deployer allowed by ad ${consumers.length ? '(private)' : '(public)'}`);
    console.log(`  fee             : ${feeOk}`);
    console.log(`  version         : ${ver ? `${getHumanReadableVersion(ver)} (build ${ver.buildNumber}, platform ${ver.platform})` : '(unknown)'}  | min required ${j(minVer)}`);
    console.log(`  reputation      : ${j(rep)}  | min required ${minRep ?? '(none)'}`);
    console.log(`  limits          : maxMemory=${restr.maxMemory} storageCapacity=${restr.storageCapacity} | job needs memory=${memory} storage=${storage}`);
    if (hb != null) {
      const ago = Math.round((now - hb) / 1000);
      console.log(`  heartbeat       : last seen ${ago}s ago (${new Date(hb).toISOString()}) ${ago < 600 ? '✅ online' : '⚠️ may be offline'}`);
    } else {
      console.log(`  heartbeat       : ⚠️ none recorded`);
    }
  }
}

const strat = reg.extra?.requirements?.assignmentStrategy ?? {};
console.log(`\n--- assignment ---`);
console.log(`strategy: ${j(strat)}  ${'instantMatch' in strat || strat.instantMatch ? '(instant-match)' : '(open matcher — relies on Canary matcher picking it up within the start window)'}`);

console.log('');
await svc.disconnect();
process.exit(0);
