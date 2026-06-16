<script lang="ts">
  import { untrack } from 'svelte';
  import type { WalletOpResultMsg } from '../../types';
  import { send } from '../lib/vscode';
  import { ICONS } from '../lib/icons';
  import { shortAddr } from '../lib/format';
  import WizardHeader from './WizardHeader.svelte';
  import PasswordStep from './PasswordStep.svelte';
  import SuccessScreen from './SuccessScreen.svelte';
  import WalletAvatar from './WalletAvatar.svelte';

  interface Props {
    network: string;
    walletOp: WalletOpResultMsg | null;
    onClose: () => void;
  }
  let { network, walletOp, onClose }: Props = $props();

  let netLabel = $derived(network.charAt(0).toUpperCase() + network.slice(1));

  type Step = 'phrase' | 'name' | 'password' | 'done' | 'dup';
  let step = $state<Step>('phrase');
  let phrase = $state('');
  let name = $state('');
  let description = $state('');
  let password = $state('');
  let confirm = $state('');
  let busy = $state(false);
  let error = $state('');
  let createdAddress = $state('');
  let createdName = $state('');
  let dupName = $state('');
  let dupAddress = $state('');

  let wordCount = $derived(phrase.trim() ? phrase.trim().split(/\s+/).length : 0);
  let validCount = $derived(wordCount === 12 || wordCount === 24);
  let normalizedPhrase = $derived(phrase.trim().replace(/\s+/g, ' '));

  let lastSeq = untrack(() => walletOp?.seq ?? -1);
  $effect(() => {
    const op = walletOp;
    if (!op || op.seq === lastSeq) return;
    lastSeq = op.seq;
    if (op.op === 'checkPhrase') {
      busy = false;
      if (!op.ok) { error = op.message ?? 'Could not validate the phrase.'; return; }
      if (!op.valid) { error = "That recovery phrase isn't valid — check the words and their order."; return; }
      if (op.duplicate) {
        dupName = op.existingName ?? 'an existing wallet';
        dupAddress = op.existingAddress ?? '';
        step = 'dup';
        return;
      }
      error = '';
      step = 'name';
    } else if (op.op === 'import') {
      busy = false;
      if (op.ok) {
        createdAddress = op.address ?? '';
        createdName = op.name ?? name;
        error = '';
        step = 'done';
      } else {
        error = op.message ?? 'Could not import the wallet.';
      }
    }
  });

  function checkPhrase() {
    if (!validCount || busy) return;
    busy = true;
    error = '';
    send('wallet.checkPhrase', { mnemonic: normalizedPhrase });
  }
  function submitImport() {
    busy = true;
    error = '';
    send('wallet.import', {
      mnemonic: normalizedPhrase,
      name: name.trim(),
      description: description.trim(),
      password,
    });
  }
  function useDifferentPhrase() {
    phrase = '';
    error = '';
    step = 'phrase';
  }
</script>

{#if step === 'phrase'}
  <div class="wizard">
    <WizardHeader title="Import wallet" step="1 / 3" onBack={onClose} />
    <div class="wz-body">
      <p class="wz-desc">Paste your 12 or 24-word recovery phrase. It's encrypted on this device and never leaves your machine.</p>

      <div class="wz-field">
        <span class="wz-label">Recovery phrase</span>
        <!-- svelte-ignore a11y_autofocus -->
        <textarea class="wz-input wz-phrase-input" bind:value={phrase} rows="3" placeholder="ridge comic salute oxygen mirror pelican voyage cluster ginger fossil anchor velvet" autofocus></textarea>
        {#if wordCount > 0}
          {#if validCount}
            <div class="wz-ok">{@html ICONS.check}<span>{wordCount} words · valid</span></div>
          {:else}
            <div class="wz-hint-warn">{@html ICONS.warning}<span>{wordCount} word{wordCount === 1 ? '' : 's'} · needs 12 or 24 words</span></div>
          {/if}
        {/if}
      </div>

      {#if error}<div class="wz-err"><span>{error}</span></div>{/if}

      <button class="full primary-green with-icon" disabled={!validCount || busy} onclick={checkPhrase}>
        {@html ICONS.arrowRight} {busy ? 'Checking…' : 'Continue'}
      </button>
      <button class="wz-cancel" onclick={onClose}>Cancel</button>
    </div>
  </div>
{:else if step === 'name'}
  <div class="wizard">
    <WizardHeader title="Import wallet" step="2 / 3" onBack={() => (step = 'phrase')} />
    <div class="wz-body">
      <p class="wz-desc">Name this wallet so you can tell it apart from others on the network.</p>

      <div class="wz-field">
        <div class="wz-label-row">
          <span class="wz-label">Wallet name</span>
          <span class="wz-count">{name.length} / 40</span>
        </div>
        <!-- svelte-ignore a11y_autofocus -->
        <input class="wz-input" bind:value={name} maxlength="40" placeholder="Treasury" autofocus />
      </div>

      <div class="wz-field">
        <span class="wz-label">Description · optional</span>
        <input class="wz-input" bind:value={description} maxlength="200" placeholder="Restored cold wallet" />
      </div>

      <button class="full primary-green with-icon" disabled={!name.trim()} onclick={() => (step = 'password')}>
        {@html ICONS.arrowRight} Continue
      </button>
      <button class="wz-cancel" onclick={onClose}>Cancel</button>
    </div>
  </div>
{:else if step === 'password'}
  <div class="wizard">
    <WizardHeader title="Set a password" step="3 / 3" onBack={() => (step = 'name')} />
    <div class="wz-body">
      <p class="wz-desc">Encrypts the imported recovery phrase on this device. You'll enter it to reveal the phrase or sign a deploy.</p>

      <PasswordStep
        bind:password
        bind:confirm
        {busy}
        {error}
        ctaIcon={ICONS.importIcon}
        ctaLabel="Import wallet"
        busyLabel="Importing…"
        onSubmit={submitImport}
      />
    </div>
  </div>
{:else if step === 'dup'}
  <div class="wizard">
    <WizardHeader title="Import wallet" onBack={useDifferentPhrase} />
    <div class="wz-body">
      <div class="wz-warn danger">
        {@html ICONS.warning}
        <div>
          <div class="wz-warn-title">Already in your vault</div>
          <div class="wz-warn-sub">This phrase already backs "{dupName}". Re-importing the same wallet isn't allowed.</div>
        </div>
      </div>

      <span class="wz-label">Existing wallet</span>
      <div class="wz-existing">
        <WalletAvatar size={30} />
        <div class="wz-existing-info">
          <div class="wz-existing-name">{dupName}</div>
          <div class="wz-existing-addr">{shortAddr(dupAddress)}</div>
        </div>
      </div>

      <button class="full secondary" onclick={useDifferentPhrase}>Use a different phrase</button>
      <button class="wz-cancel" onclick={onClose}>Cancel import</button>
    </div>
  </div>
{:else}
  <SuccessScreen
    name={createdName}
    subtitle={`Imported & set active on ${netLabel}`}
    address={createdAddress}
    onGo={onClose}
  />
{/if}
