<script lang="ts">
  import { ICONS } from '../lib/icons';

  interface Props {
    onCreate: () => void;
    onImport: () => void;
    onRefresh: () => void;
  }
  let { onCreate, onImport, onRefresh }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLElement>();

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    open = !open;
  }
  function pick(fn: () => void) {
    open = false;
    fn();
  }

  // Same dismiss behaviour as WalletMenu: outside pointerdown (capture) / Escape.
  $effect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (root && !root.contains(e.target as Node)) open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') open = false;
    }
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  });
</script>

<div class="wallet-menu" bind:this={root}>
  <button
    class="wallet-menu-trigger"
    class:open
    onclick={toggle}
    title="Wallet actions"
    aria-label="Wallet actions"
    aria-haspopup="menu"
    aria-expanded={open}
  >
    {@html ICONS.dots}
  </button>

  {#if open}
    <div class="wallet-menu-pop" role="menu">
      <button class="wallet-menu-item" role="menuitem" onclick={() => pick(onCreate)}>
        {@html ICONS.plus}<span>New wallet</span>
      </button>
      <button class="wallet-menu-item" role="menuitem" onclick={() => pick(onImport)}>
        {@html ICONS.importIcon}<span>Import existing</span>
      </button>
      <button class="wallet-menu-item" role="menuitem" onclick={() => pick(onRefresh)}>
        {@html ICONS.refresh}<span>Refresh balances</span>
      </button>
    </div>
  {/if}
</div>
