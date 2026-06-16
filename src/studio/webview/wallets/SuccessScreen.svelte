<script lang="ts">
  import { ICONS } from '../lib/icons';
  import { shortAddr } from '../lib/format';
  import WalletAvatar from './WalletAvatar.svelte';

  interface Props {
    name: string;
    /** e.g. "Now your active wallet on Mainnet" / "Imported & set active on Mainnet". */
    subtitle: string;
    address: string;
    ctaLabel?: string;
    onGo: () => void;
  }
  let { name, subtitle, address, ctaLabel = 'Go to wallet', onGo }: Props = $props();
</script>

<div class="wizard">
  <div class="wizard-head"><span class="wz-title">All set</span></div>
  <div class="success-body">
    <div class="success-check">{@html ICONS.check}</div>
    <div class="success-title">{name} is ready</div>
    <div class="success-sub">{subtitle}</div>

    <div class="success-card">
      <WalletAvatar size={30} />
      <div class="success-card-info">
        <div class="success-card-name">{name}</div>
        <div class="success-card-addr">{shortAddr(address)}</div>
      </div>
      <span class="wallet-badge">Active</span>
    </div>

    <button class="full primary-green with-icon" onclick={onGo}>
      {@html ICONS.arrowRight} {ctaLabel}
    </button>
  </div>
</div>
