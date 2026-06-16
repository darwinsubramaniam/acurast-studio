<script lang="ts">
  import { ICONS } from '../lib/icons';
  import { passwordStrength } from '../lib/password';
  import PasswordField from './PasswordField.svelte';

  interface Props {
    password: string;
    confirm: string;
    busy?: boolean;
    error?: string;
    /** SVG icon string for the CTA (defaults to a lock). */
    ctaIcon?: string;
    ctaLabel: string;
    busyLabel?: string;
    onSubmit: () => void;
  }
  let {
    password = $bindable(''),
    confirm = $bindable(''),
    busy = false,
    error = '',
    ctaIcon,
    ctaLabel,
    busyLabel = 'Working…',
    onSubmit,
  }: Props = $props();

  let strength = $derived(passwordStrength(password));
  let pwMatch = $derived(confirm.length > 0 && confirm === password);
  let canSubmit = $derived(password.length >= 8 && password === confirm && !busy);

  function submit() {
    if (canSubmit) onSubmit();
  }
</script>

<div class="wz-field">
  <span class="wz-label">Password</span>
  <PasswordField bind:value={password} />
  <div class="pw-strength" data-score={strength.score}>
    <div class="pw-bars">
      {#each [1, 2, 3, 4] as n (n)}<span class="pw-bar" class:on={n <= strength.score}></span>{/each}
    </div>
    <span class="pw-strength-label">{strength.label}</span>
  </div>
</div>

<div class="wz-field">
  <span class="wz-label">Confirm password</span>
  <PasswordField bind:value={confirm} onEnter={submit} />
  {#if confirm.length > 0}
    {#if pwMatch}
      <div class="wz-ok">{@html ICONS.check}<span>Passwords match</span></div>
    {:else}
      <div class="wz-err"><span>Passwords don't match yet</span></div>
    {/if}
  {/if}
</div>

{#if error}<div class="wz-err"><span>{error}</span></div>{/if}

<button class="full primary-green with-icon" disabled={!canSubmit} onclick={submit}>
  {@html ctaIcon ?? ICONS.lock} {busy ? busyLabel : ctaLabel}
</button>
<div class="wz-note">Minimum 8 characters · stored only on this machine</div>
