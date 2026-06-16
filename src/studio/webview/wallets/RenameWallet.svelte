<script lang="ts">
  import { untrack } from 'svelte';
  import type { WalletInfo, WalletOpResultMsg } from '../../types';
  import { send } from '../lib/vscode';
  import { ICONS } from '../lib/icons';
  import WizardHeader from './WizardHeader.svelte';

  interface Props {
    wallet: WalletInfo;
    /** Same screen serves both labels — only the field + target message differ. */
    mode: 'rename' | 'editDescription';
    walletOp: WalletOpResultMsg | null;
    onClose: () => void;
  }
  let { wallet, mode, walletOp, onClose }: Props = $props();

  const isRename = untrack(() => mode) === 'rename';
  // Seed the editable field from the wallet once; later edits live in `value`.
  let value = $state(untrack(() => (isRename ? wallet.name : wallet.description)));
  let busy = $state(false);
  let error = $state('');

  const maxLen = isRename ? 40 : 200;
  let canSave = $derived((!isRename || value.trim().length > 0) && !busy);

  let lastSeq = untrack(() => walletOp?.seq ?? -1);
  $effect(() => {
    const op = walletOp;
    if (!op || op.seq === lastSeq) return;
    lastSeq = op.seq;
    if (op.op !== mode || op.id !== wallet.id) return;
    busy = false;
    if (op.ok) onClose();
    else error = op.message ?? 'Could not save your changes.';
  });

  function save() {
    if (!canSave) return;
    busy = true;
    error = '';
    if (isRename) send('wallet.rename', { id: wallet.id, name: value.trim() });
    else send('wallet.editDescription', { id: wallet.id, description: value.trim() });
  }
</script>

<div class="wizard">
  <WizardHeader title={isRename ? 'Rename wallet' : 'Edit description'} onBack={onClose} />
  <div class="wz-body">
    <p class="wz-desc">
      {#if isRename}
        Give "{wallet.name}" a name you'll recognise. Labels are local only — never written on-chain.
      {:else}
        Describe "{wallet.name}" so you can tell it apart. Labels are local only — never written on-chain.
      {/if}
    </p>

    <div class="wz-field">
      <div class="wz-label-row">
        <span class="wz-label">{isRename ? 'Wallet name' : 'Description'}</span>
        <span class="wz-count">{value.length} / {maxLen}</span>
      </div>
      {#if isRename}
        <!-- svelte-ignore a11y_autofocus -->
        <input class="wz-input" bind:value maxlength={maxLen} placeholder="Main Deployer" autofocus />
      {:else}
        <!-- svelte-ignore a11y_autofocus -->
        <input class="wz-input" bind:value maxlength={maxLen} placeholder="Primary mainnet signer" autofocus />
      {/if}
    </div>

    {#if error}<div class="wz-err"><span>{error}</span></div>{/if}

    <button class="full primary-green with-icon" disabled={!canSave} onclick={save}>
      {@html ICONS.check} {busy ? 'Saving…' : isRename ? 'Save name' : 'Save description'}
    </button>
    <button class="wz-cancel" onclick={onClose}>Cancel</button>
  </div>
</div>
