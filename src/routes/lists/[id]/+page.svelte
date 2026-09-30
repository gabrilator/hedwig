<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import { toast } from '$lib/ui/motion.svelte';
  let { data, form } = $props();
  let selected = $state<string[]>([]);
  /** The one cell being edited in place, and what has been typed so far. */
  let editing = $state<{ contactId: string; key: string } | null>(null);
  let draft = $state('');
  const isEditing = (contactId: string, key: string) => editing?.contactId === contactId && editing?.key === key;
  const shown = (value: unknown) => value === null || value === undefined || value === '' ? '' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
  const hint = (cell: any) => !cell ? 'Not researched yet. Click to type a value.' : `${cell.kind}${cell.sources?.length ? ' · ' + cell.sources.join('\n') : ''}`;
  async function edit(contactId: string, key: string, value: unknown) {
    editing = { contactId, key }; draft = value === null || value === undefined ? '' : String(value);
    await tick(); const el = document.querySelector('.cell-edit [name="value"]') as HTMLInputElement | HTMLSelectElement | null; el?.focus(); if (el instanceof HTMLInputElement) el.select();
  }
  /** Enter saves, Escape cancels; the form's own submit keeps working for the Save button. */
  const keys = (e: KeyboardEvent) => { if (e.key === 'Escape') editing = null; else if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement & { form?: HTMLFormElement | null }).form?.requestSubmit(); } };
  const saveCell = () => async ({ result }: any) => { if (result.type === 'success') { editing = null; await invalidateAll(); } else toast(result.data?.error ?? 'Could not save.', 'err', 7000); };
  /** The message is built at submit time: `enhance` keeps the function it was first given, so a closed-over count would go stale. */
  const confirmed = (message: () => string) => ({ cancel }: any) => { if (!confirm(message())) { cancel(); return; } return async ({ update }: any) => { selected = []; await update({ reset: false }); await invalidateAll(); }; };
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
</script>
<svelte:head><title>{data.table.name} · Lists · Hedwig</title></svelte:head>
<div style="padding:28px">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px"><div><a href="/lists">← Lists</a><h1>{data.table.name}</h1></div>
<form method="POST" action="?/deleteList" use:enhance={confirmed(() => `Delete the list "${data.table.name}"? Contacts that are only in this list are removed too. Recipients already added to a campaign are not affected.`)}><button class="btn sm ghost">Delete list</button></form></div>
{#if page.url.searchParams.get("imported")}<p class="flash">{page.url.searchParams.get("imported")}</p>{/if}
<p class="mute">Click a cell to edit it. Edits here do not change enrolled campaign recipients.</p>
{#if form?.error}<p class="err">{form.error}</p>{/if}
{#if form?.result && form.result.saved === undefined}
  <div class="flash" role="status">
    {#if form.result.enrolled !== undefined}{form.result.enrolled} contacts enrolled. The campaign remains stopped.
    {:else if form.result.removed !== undefined}{n(form.result.removed, 'contact')} removed from this list.
    {:else}Column added.{/if}
    {#each form.result.results ?? [] as result}
      {#if !['saved', 'enrolled'].includes(result.status)}<p>{result.detail ?? result.status.replaceAll('_', ' ')}</p>{/if}
    {/each}
  </div>
{/if}
<details style="margin:18px 0"><summary>Add a column</summary><form method="POST" action="?/column" class="column-form">
<label>Column name<input class="in" name="label" placeholder="Hiring signal" required/></label><label>Variable key<input class="in" name="key" placeholder="hiringSignal" pattern={"[a-zA-Z][a-zA-Z0-9_]{0,63}"} required/></label>
<label>Type<select class="in" name="type"><option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes / no</option><option value="url">Website address</option></select></label>
<label>Instructions<input class="in" name="description" placeholder="What should this column contain?"/></label><button class="btn">Add column</button></form></details>
<form method="POST" action="?/enroll" style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:18px 0">
{#each selected as id}<input type="hidden" name="contactIds" value={id}/>{/each}
<select class="in" name="campaignId" aria-label="Campaign" required style="width:auto"><option value="">Choose a stopped campaign</option>{#each data.campaigns as campaign}<option value={campaign._id}>{campaign.name} · {campaign.status}</option>{/each}</select>
<label><input type="checkbox" name="allowPreviousOutreach"/> Allow previous outreach</label><button class="btn" disabled={!selected.length}>Add {selected.length} selected</button><button class="btn" formaction="?/enrollAll">Add entire list</button></form>
{#if selected.length}<form method="POST" action="?/deleteRows" use:enhance={confirmed(() => `Remove ${n(selected.length, 'contact')} from this list? A contact that is in no other list is deleted. Recipients already added to a campaign are not affected.`)} style="display:flex;align-items:center;gap:12px;margin:0 0 10px">
{#each selected as id}<input type="hidden" name="contactIds" value={id}/>{/each}
<span class="mute">{selected.length} selected</span><button class="btn sm red">Delete {selected.length} selected</button><button class="btn sm ghost" type="button" onclick={() => { selected = []; }}>Clear</button></form>{/if}
<div class="wrap" style="overflow:auto"><table class="grid"><thead><tr><th></th><th>Email / identity</th>{#each data.table.columns as column}<th title={column.description}>{column.label}</th>{/each}</tr></thead><tbody>
{#each data.rows as row (row._id)}<tr><td class="sel"><input type="checkbox" aria-label="Select {row.email ?? row.domain ?? row.profileUrl}" value={row._id} bind:group={selected}/></td><td class="id">{row.email ?? row.domain ?? row.profileUrl}<small class="mute">{row.kind}</small></td>
{#each data.table.columns as column (column.key)}{@const cell = row.fields[column.key]}<td>
{#if isEditing(row._id, column.key)}
<form method="POST" action="?/cell" class="cell-edit" use:enhance={saveCell}><input type="hidden" name="contactId" value={row._id}/><input type="hidden" name="kind" value={row.kind}/><input type="hidden" name="key" value={column.key}/><input type="hidden" name="type" value={column.type}/>
{#if column.type === 'boolean'}<select class="in" name="value" aria-label={column.label} bind:value={draft} onkeydown={keys}><option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option></select>
{:else}<input class="in" name="value" aria-label={column.label} bind:value={draft} type={column.type === 'number' ? 'number' : column.type === 'url' ? 'url' : 'text'} step="any" onkeydown={keys}/>{/if}
<button class="btn sm" type="submit">Save</button><button class="btn sm ghost" type="button" onclick={() => { editing = null; }}>Cancel</button></form>
{:else}<button type="button" class="cellbtn" class:empty={shown(cell?.value) === ''} title={hint(cell)} onclick={() => edit(row._id, column.key, cell?.value)}>{shown(cell?.value) || '—'}</button>{/if}
</td>{/each}</tr>
{:else}<tr><td colspan={data.table.columns.length + 2} style="padding:10px">No contacts yet.</td></tr>{/each}
</tbody></table></div>
{#if data.nextCursor}<a class="btn ghost" href="?after={data.nextCursor}" style="margin-top:12px">Next page →</a>{/if}
</div>
<style>
  .column-form { display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:16px;align-items:end; }
  details summary { cursor:pointer; }
  .grid { font-size:12px; min-width:0; }
  .grid th { padding:6px 8px; font-size:10px; border:1px dashed var(--line); border-bottom:2px solid var(--bone); white-space:nowrap; }
  .grid td { padding:0; border:1px dashed var(--line); vertical-align:top; min-width:140px; max-width:320px; }
  .grid tbody tr:last-child td { border-bottom:1px dashed var(--line); }
  .grid td.sel { padding:6px 8px; min-width:0; width:1%; }
  .grid td.id { padding:6px 8px; min-width:0; white-space:nowrap; }
  .grid td.id small { display:block; font-size:10px; }
  .cellbtn { display:-webkit-box; -webkit-line-clamp:4; line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; width:100%; text-align:left; background:none; border:0; padding:6px 8px; font:inherit; color:inherit; cursor:text; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.35; }
  .cellbtn:hover, .cellbtn:focus-visible { background:var(--panel2); outline:none; }
  .cellbtn.empty { color:var(--mute); }
  .cell-edit { display:flex; gap:4px; padding:4px; align-items:center; }
  .cell-edit .in { flex:1; min-width:120px; padding:4px 6px; font-size:12px; }
</style>
