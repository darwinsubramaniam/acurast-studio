<script lang="ts">
  import type { WalletInfo, BalanceMsg, WalletOpResultMsg } from '../../types';
  import { send } from '../lib/vscode';
  import WalletList from './WalletList.svelte';
  import CreateWallet from './CreateWallet.svelte';
  import ImportWallet from './ImportWallet.svelte';
  import RevealPhrase from './RevealPhrase.svelte';
  import RenameWallet from './RenameWallet.svelte';
  import DeleteWallet from './DeleteWallet.svelte';
  import type { WalletMenuAction } from './WalletMenu.svelte';

  interface Props {
    wallets: { list: WalletInfo[]; activeId: string | null; network: string; symbol: string };
    walletBalances: Record<string, BalanceMsg>;
    walletOp: WalletOpResultMsg | null;
  }
  let { wallets, walletBalances, walletOp }: Props = $props();

  type View = 'list' | 'create' | 'import' | 'reveal' | 'rename' | 'editDesc' | 'delete';
  let view = $state<View>('list');
  let targetId = $state<string | null>(null);

  let targetWallet = $derived(targetId ? (wallets.list.find((w) => w.id === targetId) ?? null) : null);

  function backToList() {
    view = 'list';
    targetId = null;
  }

  function handleAction(action: WalletMenuAction, id: string) {
    if (action === 'copyAddress') {
      const w = wallets.list.find((x) => x.id === id);
      if (w) send('wallet.copy', { text: w.address, note: 'Address copied to clipboard' });
      return;
    }
    if (action === 'setActive') {
      send('wallet', { action: 'setActive', id });
      return;
    }
    targetId = id;
    if (action === 'reveal') view = 'reveal';
    else if (action === 'rename') view = 'rename';
    else if (action === 'editDescription') view = 'editDesc';
    else if (action === 'delete') view = 'delete';
  }
</script>

{#if view === 'create'}
  <CreateWallet network={wallets.network} {walletOp} onClose={backToList} />
{:else if view === 'import'}
  <ImportWallet network={wallets.network} {walletOp} onClose={backToList} />
{:else if view === 'reveal' && targetWallet}
  <RevealPhrase wallet={targetWallet} {walletOp} onClose={backToList} />
{:else if view === 'rename' && targetWallet}
  <RenameWallet wallet={targetWallet} mode="rename" {walletOp} onClose={backToList} />
{:else if view === 'editDesc' && targetWallet}
  <RenameWallet wallet={targetWallet} mode="editDescription" {walletOp} onClose={backToList} />
{:else if view === 'delete' && targetWallet}
  <DeleteWallet wallet={targetWallet} {walletOp} onClose={backToList} />
{:else}
  <WalletList
    {wallets}
    balances={walletBalances}
    onCreate={() => (view = 'create')}
    onImport={() => (view = 'import')}
    onRefresh={() => send('refreshBalance')}
    onAction={handleAction}
  />
{/if}
