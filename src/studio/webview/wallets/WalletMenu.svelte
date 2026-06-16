<script lang="ts">
  import { ICONS } from '../lib/icons';

  export type WalletMenuAction =
    | 'copyAddress' | 'rename' | 'editDescription' | 'reveal' | 'setActive' | 'delete';

  interface Props {
    /** Hide "Set active" for the wallet that is already active. */
    isActive: boolean;
    onAction: (action: WalletMenuAction) => void;
  }
  let { isActive, onAction }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLElement>();

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    open = !open;
  }
  function pick(action: WalletMenuAction) {
    open = false;
    onAction(action);
  }

  // Close on outside click / Escape while open. Capture-phase pointerdown so a
  // click anywhere outside dismisses before it lands on another control.
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
    title="Actions"
    aria-label="Wallet actions"
    aria-haspopup="menu"
    aria-expanded={open}
  >
    {@html ICONS.dots}
  </button>

  {#if open}
    <div class="wallet-menu-pop" role="menu">
      <button class="wallet-menu-item" role="menuitem" onclick={() => pick('copyAddress')}>
        {@html ICONS.copy}<span>Copy address</span>
      </button>
      <button class="wallet-menu-item" role="menuitem" onclick={() => pick('rename')}>
        {@html ICONS.pencil}<span>Rename</span>
      </button>
      <button class="wallet-menu-item" role="menuitem" onclick={() => pick('editDescription')}>
        {@html ICONS.lines}<span>Edit description</span>
      </button>
      <button class="wallet-menu-item" role="menuitem" onclick={() => pick('reveal')}>
        {@html ICONS.eye}<span>Reveal phrase</span>
      </button>
      {#if !isActive}
        <button class="wallet-menu-item" role="menuitem" onclick={() => pick('setActive')}>
          {@html ICONS.check}<span>Set active</span>
        </button>
      {/if}
      <button class="wallet-menu-item danger" role="menuitem" onclick={() => pick('delete')}>
        {@html ICONS.trash}<span>Delete wallet</span>
      </button>
    </div>
  {/if}
</div>
