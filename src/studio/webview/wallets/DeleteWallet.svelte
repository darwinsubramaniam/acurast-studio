<script lang="ts">
  import { untrack } from 'svelte';
  import type { WalletInfo, WalletOpResultMsg } from '../../types';
  import { send } from '../lib/vscode';
  import { ICONS } from '../lib/icons';
  import { shortAddr } from '../lib/format';
  import WizardHeader from './WizardHeader.svelte';
  import WalletAvatar from './WalletAvatar.svelte';

  interface Props {
    wallet: WalletInfo;
    walletOp: WalletOpResultMsg | null;
    onClose: () => void;
  }
  let { wallet, walletOp, onClose }: Props = $props();

  let busy = $state(false);
  let error = $state('');

  let lastSeq = untrack(() => walletOp?.seq ?? -1);
  $effect(() => {
    const op = walletOp;
    if (!op || op.seq === lastSeq) return;
    lastSeq = op.seq;
    if (op.op !== 'delete' || op.id !== wallet.id) return;
    busy = false;
    if (op.ok) onClose();
    else error = op.message ?? 'Could not delete the wallet.';
  });

  function remove() {
    if (busy) return;
    busy = true;
    error = '';
    send('wallet.delete', { id: wallet.id });
  }
</script>

<div class="wizard">
  <WizardHeader title="Delete wallet" onBack={onClose} />
  <div class="wz-body wz-body-center">
    <div class="delete-icon">{@html ICONS.trash}</div>
    <div class="delete-title">Delete "{wallet.name}"?</div>
    <p class="wz-desc center">
      Deleting it from this device is permanent. You can only restore it from its 12-word recovery
      phrase — Acurast can't reset it.
    </p>

    <div class="wz-existing">
      <WalletAvatar size={30} />
      <div class="wz-existing-info">
        <div class="wz-existing-name">{wallet.name}</div>
        <div class="wz-existing-addr">{shortAddr(wallet.address)}</div>
      </div>
    </div>

    {#if error}<div class="wz-err"><span>{error}</span></div>{/if}

    <button class="full danger-solid with-icon" disabled={busy} onclick={remove}>
      {@html ICONS.trash} {busy ? 'Deleting…' : 'Delete wallet'}
    </button>
    <button class="wz-cancel" onclick={onClose}>Cancel</button>
  </div>
</div>
