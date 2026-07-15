import * as vscode from 'vscode';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { WalletService, ACURAST_SS58_PREFIX } from '../wallet/walletService';
import { validateAdvertiseArgs } from './advertiseValidation';
import { StudioPanel } from '../studio/studioPanel';
import { acurastClient } from '../sdk/acurastClient';
import { type AcurastNetwork } from '../sdk/constants';
import type { NewAdvertisementParams } from '../studio/types';

interface AdvertiseModulesArgs {
  /** Vault id of the manager wallet that signs the extrinsic. */
  walletId: string;
  /** Processor address whose advertisement is updated. */
  processor: string;
  /** Full replacement set of advertised modules. */
  modules: string[];
  network: string;
  /**
   * Present for the "Start advertising" flow: full advertisement values for a
   * processor that has never advertised (nothing on chain to copy from).
   */
  newAd?: NewAdvertisementParams;
}

interface Deps {
  wallet: WalletService;
  output: vscode.OutputChannel;
  studioPanel: StudioPanel;
}

/**
 * Re-advertises a managed processor with a new module set via
 * `acurastProcessorManager.advertiseFor`, signed by the manager wallet.
 * Triggered from the Processors view; not exposed in the palette because it
 * requires a processor/wallet argument the palette can't supply.
 */
export async function advertiseModules(
  { wallet, output, studioPanel }: Deps,
  args?: AdvertiseModulesArgs,
) {
  const validationError = validateAdvertiseArgs(args);
  if (validationError || !args) {
    if (validationError) vscode.window.showErrorMessage(`Cannot advertise: ${validationError}`);
    return;
  }
  const { walletId, processor, modules, network, newAd } = args;

  const info = (await wallet.list()).find((w) => w.id === walletId);
  if (!info) {
    vscode.window.showErrorMessage('Manager wallet not found.');
    return;
  }

  try {
    // Build the exact extrinsic first so the confirm dialog can show its real
    // args. Reading the current advertisement can fail (e.g. not advertising).
    let prepared: Awaited<ReturnType<typeof acurastClient.prepareAdvertiseModules>>;
    try {
      prepared = newAd
        ? await acurastClient.prepareStartAdvertising(
            network as AcurastNetwork,
            processor,
            modules,
            newAd
          )
        : await acurastClient.prepareAdvertiseModules(
            network as AcurastNetwork,
            processor,
            modules
          );
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Could not prepare transaction: ${(err as Error).message}`);
      return;
    }

    const call = `${prepared.preview.section}.${prepared.preview.method}`;
    const payload = JSON.stringify(prepared.preview.args, null, 2);
    output.appendLine(`[advertise] preview ${call} ${JSON.stringify(prepared.preview.args)}`);

    const caution = newAd
      ? `This publishes a new public advertisement on the marketplace. Make sure the pricing and capacity values match what the device can actually deliver — matched jobs it can't execute will fail.`
      : `Only advertise modules this processor can actually run — matched jobs it can't execute will fail.`;
    const confirm = await vscode.window.showWarningMessage(
      `Sign and submit ${call} from "${info.name}"?`,
      {
        modal: true,
        detail:
          `Network: ${network}\n\n` +
          `${call}\n${payload}\n\n` +
          caution,
      },
      'Sign & Submit'
    );
    if (confirm !== 'Sign & Submit') return;

    const password = await vscode.window.showInputBox({
      prompt: `Enter password for "${info.name}" to sign`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return;

    let mnemonic: string;
    try {
      mnemonic = await wallet.reveal(walletId, password);
    } catch (err: unknown) {
      vscode.window.showErrorMessage((err as Error).message);
      return;
    }

    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519', ss58Format: ACURAST_SS58_PREFIX });
    const signer = keyring.addFromMnemonic(mnemonic);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: newAd
          ? `Publishing advertisement for ${processor.slice(0, 10)}…`
          : `Advertising modules for ${processor.slice(0, 10)}…`,
        cancellable: false,
      },
      async () => {
        try {
          const hash = await prepared.submit(signer);
          output.appendLine(`[advertise] ${processor} modules=[${modules.join(', ')}] tx=${hash}`);
          vscode.window.showInformationMessage(
            newAd
              ? `Advertisement published with modules: ${modules.join(', ') || '(none)'}.`
              : `Updated advertised modules to: ${modules.join(', ') || '(none)'}.`
          );
        } catch (err: unknown) {
          const msg = (err as Error).message;
          output.appendLine(`[advertise] failed: ${msg}`);
          vscode.window.showErrorMessage(`Advertise failed: ${msg}`);
        }
      }
    );
  } finally {
    // Always re-sync the Processors view — including when the confirm/password
    // prompt is cancelled — so the webview's optimistic "applying" state clears.
    await studioPanel.refreshProcessors(info.address, network);
  }
}
