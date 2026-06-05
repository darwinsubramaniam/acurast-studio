import type { WalletService } from '../wallet/walletService';
import type { DeploymentStore } from '../deployments/deploymentStore';

// Dev-only: populates the Studio panel with a wallet + a past deployment so the
// README recording (scripts/record-demo.mjs) shows real content instead of
// empty states. Gated behind ACURAST_DEMO_SEED=1 — never runs in production.
//
// Throwaway, well-known BIP39 test phrase. NEVER fund this address; it exists
// only to render a wallet card in the demo.
const DEMO_MNEMONIC =
  'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
const DEMO_PASSWORD = 'demo-password';

export async function seedDemoData(
  wallet: WalletService,
  deployments: DeploymentStore,
): Promise<void> {
  // Idempotent: import throws "already exists" on a re-run with the same seed.
  let address = '';
  try {
    if ((await wallet.count()) === 0) {
      const info = await wallet.import(
        DEMO_MNEMONIC,
        { name: 'Demo Wallet', description: 'Recording demo — do not fund' },
        DEMO_PASSWORD,
      );
      await wallet.setActive(info.id);
      address = info.address;
    } else {
      address = (await wallet.getActive())?.address ?? '';
    }
  } catch {
    address = (await wallet.getActive())?.address ?? '';
  }

  if (deployments.getAll().length === 0) {
    const now = Date.now();
    const day = 86_400_000;
    await deployments.save({
      id: 'demo-deployment-1',
      project: 'demo',
      network: 'canary',
      startedAt: now - day,
      finishedAt: now - day + 41_000,
      jobIds: [{ origin: address, localId: 84213 }],
      ipfsHash: 'QmXoyp1z9V8aD5x6kP3rJ2bN4mT7wQ8sLcV1hF9gE2dC3b',
      txHash: '0x9f1c4a7e2b8d6053c1a4f9e7d2b8c6a3e5f0d9b7c2a1e8f6',
      // Point at the real recording workspace so the card doesn't show a red
      // "source path no longer exists" warning. Falls back to a label.
      projectPath: process.env.ACURAST_DEMO_PROJECT_PATH || 'demo-workspace/acurast.json',
    });
  }
}
