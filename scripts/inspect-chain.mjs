// Dev utility — connects to Acurast canary + mainnet, enumerates every
// extrinsic the chain exposes, and flags anything sweep/refund-adjacent.
//
// Run with:  node scripts/inspect-chain.mjs
//
// The SDK is ESM; this file is .mjs so the import works without any
// transpile step.

import { AcurastService } from '@acurast/sdk/chain';

const ENDPOINTS = {
  canary:  'wss://public-rpc.canary.acurast.com',
  mainnet: 'wss://public-rpc.mainnet.acurast.com',
};

// What we're hunting for: any extrinsic that could refund / sweep / reclaim
// destination-chain gas held by processor-derived addresses, or any
// fund-movement helper the SDK hasn't wrapped.
const KEYWORDS = [
  'sweep', 'refund', 'withdraw', 'recover', 'reclaim', 'rebate',
  'reimburse', 'unlock', 'claim', 'return', 'drain', 'forfeit',
  'topup', 'top_up', 'fund', 'deposit',
];

function matchesKeyword(label) {
  const lower = label.toLowerCase();
  return KEYWORDS.filter((k) => lower.includes(k));
}

async function inspect(network, endpoint) {
  console.log(`\n========== ${network} (${endpoint}) ==========`);
  const svc = new AcurastService(endpoint);
  const api = await svc.connect();
  try {
    const sections = Object.keys(api.tx).sort();

    // 1. Full list of acurast* pallet calls (small, useful as documentation)
    console.log(`\n--- acurast* pallets ---`);
    for (const section of sections) {
      if (!section.toLowerCase().startsWith('acurast')) continue;
      const methods = Object.keys(api.tx[section]).sort();
      console.log(`${section}: ${methods.length} extrinsics`);
      for (const m of methods) {
        const meta = api.tx[section][m]?.meta;
        const args = (meta?.args ?? []).map((a) => `${a.name.toString()}: ${a.type.toString()}`).join(', ');
        console.log(`  • ${section}.${m}(${args})`);
      }
    }

    // 2. Keyword sweep across *all* pallets (including balances, treasury, etc.)
    console.log(`\n--- keyword matches across every pallet ---`);
    let hits = 0;
    for (const section of sections) {
      for (const method of Object.keys(api.tx[section])) {
        const label = `${section}.${method}`;
        const kws = matchesKeyword(label);
        if (kws.length) {
          console.log(`  HIT (${kws.join(',')}): ${label}`);
          hits++;
        }
      }
    }
    if (!hits) console.log('  (no matches)');

    // 3. Events in acurast* pallets — what statusCallback would see on-chain
    console.log(`\n--- acurast* events ---`);
    const eventSections = Object.keys(api.events).sort();
    for (const section of eventSections) {
      if (!section.toLowerCase().startsWith('acurast')) continue;
      const methods = Object.keys(api.events[section]).sort();
      console.log(`${section}: ${methods.length} events`);
      for (const m of methods) {
        const meta = api.events[section][m]?.meta;
        const fields = (meta?.fields ?? meta?.args ?? []).map((f) => {
          const name = f.name?.unwrapOr?.(undefined)?.toString?.() ?? f.name?.toString?.() ?? '';
          const type = f.type?.toString?.() ?? '';
          return name ? `${name}: ${type}` : type;
        }).filter(Boolean).join(', ');
        console.log(`  • ${section}.${m}(${fields})`);
      }
    }

    // 4. Summary
    let total = 0;
    for (const s of sections) total += Object.keys(api.tx[s]).length;
    let totalEvents = 0;
    for (const s of eventSections) totalEvents += Object.keys(api.events[s]).length;
    console.log(`\n${network}: ${sections.length} pallets, ${total} extrinsics, ${totalEvents} events`);
  } finally {
    await svc.disconnect();
  }
}

(async () => {
  for (const [network, endpoint] of Object.entries(ENDPOINTS)) {
    try {
      await inspect(network, endpoint);
    } catch (err) {
      console.error(`${network} failed:`, err.message);
    }
  }
  process.exit(0);
})();
