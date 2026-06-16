<script lang="ts">
  import { ICONS } from '../lib/icons';

  interface Props {
    title: string;
    /** Step counter like "1 / 2"; omitted on single-screen flows. */
    step?: string;
    /** Optional leading icon (SVG string from ICONS), e.g. a lock for the reveal gate. */
    icon?: string;
    onBack?: () => void;
    onClose?: () => void;
  }
  let { title, step, icon, onBack, onClose }: Props = $props();
</script>

<div class="wizard-head">
  {#if onBack}
    <button class="wz-icon-btn" onclick={onBack} title="Back" aria-label="Back">{@html ICONS.back}</button>
  {/if}
  {#if icon}<span class="wz-lead">{@html icon}</span>{/if}
  <span class="wz-title">{title}</span>
  {#if step}<span class="wz-step">{step}</span>{/if}
  {#if onClose}
    <button class="wz-icon-btn" onclick={onClose} title="Close" aria-label="Close">{@html ICONS.close}</button>
  {/if}
</div>
