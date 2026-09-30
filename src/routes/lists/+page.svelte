<script lang="ts">
  let { data, form } = $props();
  let selected = $state<string[]>([]);
  const confirmDelete = (e: SubmitEvent) => { if (!confirm(`Delete ${selected.length === 1 ? 'this list' : `these ${selected.length} lists`}? Contacts that are only in ${selected.length === 1 ? 'it' : 'them'} are removed too. Recipients already added to a campaign are not affected.`)) e.preventDefault(); };
</script>
<svelte:head><title>Lists · Hedwig</title></svelte:head>
<div style="padding:28px;max-width:1100px"><h1>Lists</h1><p>Find and enrich contacts with your assistant, then enroll them in a campaign when they are ready.</p><p><a class="btn" href="/lists/import">Upload CSV or Excel</a></p>
{#if form?.error}<p class="err">{form.error}</p>{/if}
{#if form?.deleted !== undefined}<p class="flash" role="status">{form.deleted} list{form.deleted === 1 ? '' : 's'} deleted.</p>{/if}
<form method="POST" action="?/create" style="display:flex;gap:12px;margin:24px 0"><input class="in" name="name" placeholder="List name" aria-label="List name" required maxlength="200"/><button class="btn">New list</button></form>
{#if selected.length}<form method="POST" action="?/delete" onsubmit={confirmDelete} style="display:flex;align-items:center;gap:12px;margin:0 0 12px">
{#each selected as id}<input type="hidden" name="ids" value={id}/>{/each}
<span class="mute">{selected.length} selected</span><button class="btn sm red">Delete {selected.length} list{selected.length === 1 ? '' : 's'}</button><button class="btn sm ghost" type="button" onclick={() => { selected = []; }}>Clear</button></form>{/if}
{#each data.tables as table}<div class="card" style="display:flex;align-items:center;gap:16px;padding:20px;margin-bottom:12px"><input type="checkbox" aria-label="Select {table.name}" value={table._id} bind:group={selected}/><a href="/lists/{table._id}" style="flex:1;display:block"><strong>{table.name}</strong><p class="mute" style="margin:4px 0 0">{table.columns.length} columns · updated {new Date(table.updatedAt).toLocaleDateString()}</p></a></div>
{:else}<p class="mute">No lists yet.</p>{/each}</div>
