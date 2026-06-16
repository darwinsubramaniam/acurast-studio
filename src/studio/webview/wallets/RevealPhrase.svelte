<script lang="ts">
  import { untrack } from 'svelte';
  import type { WalletInfo, WalletOpResultMsg } from '../../types';
  import { send } from '../lib/vscode';
  import { ICONS } from '../lib/icons';
  import WizardHeader from './WizardHeader.svelte';
  import PasswordField from './PasswordField.svelte';
  import PhraseGrid from './PhraseGrid.svelte';

  interface Props {
    wallet: WalletInfo;
    walletOp: WalletOpResultMsg | null;
    onClose: () => void;
  }
  let { wallet, walletOp, onClose }: Props = $props();

  let view = $state<'gate' | 'shown'>('gate');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  let mnemonic = $state('');

  let words = $derived(mnemonic ? mnemonic.trim().split(/\s+/) : []);

  let lastSeq = untrack(() => walletOp?.seq ?? -1);
  $effect(() => {
    const op = walletOp;
    if (!op || op.seq === lastSeq) return;
    lastSeq = op.seq;
    if (op.op !== 'reveal' || op.id !== wallet.id) return;
    busy = false;
    if (op.ok) {
      mnemonic = op.mnemonic ?? '';
      error = '';
      view = 'shown';
    } else {
      error = op.message ?? 'Incorrect password — try again';
    }
  });

  function reveal() {
    if (!password || busy) return;
    busy = true;
    error = '';
    send('wallet.reveal', { id: wallet.id, password });
  }
</script>

{#if view === 'gate'}
  <div class="wizard">
    <WizardHeader title="Reveal phrase" icon={ICONS.lock} onBack={onClose} />
    <div class="wz-body">
      <p class="wz-desc">Enter the password for "{wallet.name}" to decrypt and show its 12-word recovery phrase.</p>

      <div class="wz-field">
        <span class="wz-label">Password</span>
        <PasswordField bind:value={password} onEnter={reveal} />
        {#if error}<div class="wz-err"><span>{@html ICONS.warning}{error}</span></div>{/if}
      </div>

      <button class="full primary-green with-icon" disabled={!password || busy} onclick={reveal}>
        {@html ICONS.eye} {busy ? 'Decrypting…' : 'Reveal phrase'}
      </button>
      <button class="wz-cancel" onclick={onClose}>Cancel</button>
      <div class="wz-note">Shown once · never written to disk</div>
    </div>
  </div>
{:else}
  <div class="wizard">
    <WizardHeader title="Recovery phrase" onBack={onClose} />
    <div class="wz-body">
      <div class="wz-warn danger">
        {@html ICONS.warning}
        <div class="wz-warn-title">Anyone with these {words.length} words controls "{wallet.name}".</div>
      </div>

      <PhraseGrid words={words} />

      <div class="wz-note">Hidden again when you leave this screen</div>
    </div>
  </div>
{/if}
