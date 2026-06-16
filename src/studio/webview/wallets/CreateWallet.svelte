<script lang="ts">
  import { untrack } from 'svelte';
  import type { WalletOpResultMsg } from '../../types';
  import { send } from '../lib/vscode';
  import { ICONS } from '../lib/icons';
  import WizardHeader from './WizardHeader.svelte';
  import PasswordStep from './PasswordStep.svelte';
  import PhraseGrid from './PhraseGrid.svelte';
  import SuccessScreen from './SuccessScreen.svelte';

  interface Props {
    network: string;
    /** Latest host op result; this wizard reacts only to `op === 'create'`. */
    walletOp: WalletOpResultMsg | null;
    onClose: () => void;
  }
  let { network, walletOp, onClose }: Props = $props();

  let netLabel = $derived(network.charAt(0).toUpperCase() + network.slice(1));

  let step = $state(1); // 1 name · 2 password · 3 backup · 4 done
  let name = $state('');
  let description = $state('');
  let password = $state('');
  let confirm = $state('');
  let busy = $state(false);
  let error = $state('');
  let backedUp = $state(false);
  let mnemonic = $state('');
  let createdAddress = $state('');
  let createdName = $state('');

  let words = $derived(mnemonic ? mnemonic.trim().split(/\s+/) : []);

  // Ignore any result that predates this wizard; only advance on NEW create results.
  let lastSeq = untrack(() => walletOp?.seq ?? -1);
  $effect(() => {
    const op = walletOp;
    if (!op || op.seq === lastSeq) return;
    lastSeq = op.seq;
    if (op.op !== 'create') return;
    busy = false;
    if (op.ok) {
      mnemonic = op.mnemonic ?? '';
      createdAddress = op.address ?? '';
      createdName = op.name ?? name;
      error = '';
      step = 3;
    } else {
      error = op.message ?? 'Could not create the wallet.';
    }
  });

  function submitPassword() {
    busy = true;
    error = '';
    send('wallet.create', { name: name.trim(), description: description.trim(), password });
  }
</script>

{#if step === 1}
  <div class="wizard">
    <WizardHeader title="New wallet" step="1 / 2" onBack={onClose} />
    <div class="wz-body">
      <p class="wz-desc">Name this wallet so you can tell it apart from others on the network.</p>

      <div class="wz-field">
        <div class="wz-label-row">
          <span class="wz-label">Wallet name</span>
          <span class="wz-count">{name.length} / 40</span>
        </div>
        <!-- svelte-ignore a11y_autofocus -->
        <input class="wz-input" bind:value={name} maxlength="40" placeholder="Main Deployer" autofocus />
      </div>

      <div class="wz-field">
        <span class="wz-label">Description · optional</span>
        <input class="wz-input" bind:value={description} maxlength="200" placeholder="Primary mainnet signer" />
      </div>

      <button class="full primary-green with-icon" disabled={!name.trim()} onclick={() => (step = 2)}>
        {@html ICONS.arrowRight} Continue
      </button>
      <button class="wz-cancel" onclick={onClose}>Cancel</button>
    </div>
  </div>
{:else if step === 2}
  <div class="wizard">
    <WizardHeader title="Set a password" step="2 / 2" onBack={() => (step = 1)} />
    <div class="wz-body">
      <p class="wz-desc">Encrypts the recovery phrase on this device. You'll enter it to reveal the phrase or sign a deploy.</p>

      <PasswordStep
        bind:password
        bind:confirm
        {busy}
        {error}
        ctaLabel="Create wallet"
        busyLabel="Creating…"
        onSubmit={submitPassword}
      />
    </div>
  </div>
{:else if step === 3}
  <div class="wizard">
    <WizardHeader title="Back up your wallet" onClose={onClose} />
    <div class="wz-body">
      <div class="wz-warn">
        {@html ICONS.warning}
        <div>
          <div class="wz-warn-title">Write this phrase down</div>
          <div class="wz-warn-sub">The only way to recover this wallet. Acurast can't reset it for you.</div>
        </div>
      </div>

      <PhraseGrid words={words} />

      <label class="wz-check">
        <input type="checkbox" bind:checked={backedUp} />
        <span>I've saved it somewhere safe</span>
      </label>

      <button class="full primary-green with-icon" disabled={!backedUp} onclick={() => (step = 4)}>
        {@html ICONS.check} I've backed it up
      </button>
    </div>
  </div>
{:else}
  <SuccessScreen
    name={createdName}
    subtitle={`Now your active wallet on ${netLabel}`}
    address={createdAddress}
    onGo={onClose}
  />
{/if}
