<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { n } from '$lib/ui/format';
  let { data, form } = $props();
  let busy = $state(false);
  // the column that holds the address: preselected from the file, confirmed by the user; the rest of the screen follows it
  let emailColumn = $state('');
  let loadedFor = '';
  $effect(() => { const id = data.preview?.id ?? ''; if (id !== loadedFor) { loadedFor = id; emailColumn = data.preview?.emailColumn ?? ''; } });
  const sel = $derived(data.preview?.columns.find((c: any) => c.header === emailColumn) ?? null);
  const plural = (k: number, one: string, many = one + 's') => `${n(k)} ${k === 1 ? one : many}`;
  const leftOut = $derived.by(() => {
    if (!sel || !data.preview) return [] as string[];
    const st = sel.stat, out: string[] = [];
    const noAddress = data.preview.total - st.emails;
    if (noAddress) out.push(`${plural(noAddress, 'row')} without a valid address in “${sel.header}”`);
    if (st.emails - st.unique) out.push(`${plural(st.emails - st.unique, 'duplicate')} in the file`);
    if (st.alreadyIn) out.push(`${n(st.alreadyIn)} already in this campaign`);
    if (st.suppressed) out.push(`${n(st.suppressed)} on the suppression list`);
    return out;
  });
</script>
<div class="grid2" class:single={!data.preview}>
  {#if !data.preview}
    <div class="stack">
      <div class="panel"><div class="hd"><h3>Choose an existing list</h3><a href="/lists">Manage lists →</a></div>
      <form class="bd stack" method="POST" action="?/list" use:enhance>
      <select class="in" name="listId" aria-label="Saved list" required><option value="">Choose a list</option>{#each data.lists as list}<option value={list._id}>{list.name}</option>{/each}</select>
      <p class="mute">Adds a snapshot of the list to this stopped campaign. Duplicates, suppressed contacts and previous outreach are skipped.</p>
      <button class="btn pri" disabled={!data.lists.length}>Add list to campaign</button></form></div>
      <div class="panel">
        <div class="hd"><h3>Upload the list · step 1 of 2</h3><a class="lbl" href="/campaigns/{page.params.id}/leads">← leads</a></div>
        <form class="bd stack" method="POST" action="?/upload" enctype="multipart/form-data" use:enhance={() => { busy = true; return async ({ update }) => { busy = false; await update(); }; }}>
          <label class="field"><span class="lbl">CSV or Excel file</span><input class="in" type="file" name="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" required /><span class="help">Up to 25 MB. One header row. Excel: the first sheet is used.</span></label>
          {#if form?.error}<div class="flash err">{form.error}</div>{/if}
          {#if data.error}<div class="flash err">{data.error}</div>{/if}
          <div><button class="btn pri" type="submit" disabled={busy}>{busy ? 'Reading…' : 'Upload and choose columns'}</button></div>
        </form>
      </div>
      <div class="note"><b>Only one column is required: the email address.</b> Next you confirm which column that is; rows without a valid address in it, duplicates and addresses on your suppression list are left out. Every other column is optional, can be called anything, and becomes a variable for the emails, like {'{{companyName}}'}. Nothing is sent until you activate the campaign.</div>
    </div>
  {:else}
    {@const p = data.preview}
    <form class="panel" method="POST" action="?/confirm" use:enhance style="grid-column: 1 / -1">
      <div class="hd"><h3>Step 2 of 2 · {p.fileName} · {n(p.total)} rows</h3><a class="lbl" href="/campaigns/{page.params.id}/leads/import">← another file</a></div>
      <div class="bd stack">
        <input type="hidden" name="import" value={p.id} />
        <div class="frow">
          <label class="field"><span class="lbl">Column with the email address · the To of every email</span>
            <select class="in" name="emailColumn" bind:value={emailColumn} required>
              <option value="" disabled>Choose the column…</option>
              {#each p.columns as col}<option value={col.header}>{col.header} · {col.stat.emails ? plural(col.stat.emails, 'valid address', 'valid addresses') : 'no addresses'}</option>{/each}
            </select>
            <span class="help">The only required column. A row without a valid address in it is not a lead.</span>
          </label>
          <div class="field"><span class="lbl">What gets imported</span>
            {#if sel}
              <div class="note" class:blue={sel.stat.willImport > 0} class:red={sel.stat.willImport === 0}>
                <b>{plural(sel.stat.willImport, 'lead')} will be imported.</b>
                {#if leftOut.length} Left out: {leftOut.join(' · ')}.{/if}
              </div>
            {:else}
              <div class="note">Pick the email column first.</div>
            {/if}
          </div>
        </div>
        <div class="note"><b>Every other column is optional and can be called anything.</b> Tick the ones you want to use in the emails and name the variable you will type, like {'{{companyName}}'}. Untick phone numbers, sources, notes.</div>
        <div class="wrap"><table style="min-width:0">
          <thead><tr><th>Keep</th><th>Column in the file</th><th>Variable in the emails</th><th class="rt">Filled</th><th>First values</th></tr></thead>
          <tbody>
            {#each p.columns as col (col.header)}
              <tr>
                {#if col.header === emailColumn}
                  <td>✓</td>
                  <td><span class="nm">{col.header}</span></td>
                  <td><span class="chip">To address · {'{{email}}'}</span></td>
                {:else}
                  <td><input type="checkbox" name="keep" value={col.header} checked={col.stat.filled > 0} /></td>
                  <td><span class="nm">{col.header}</span></td>
                  <td><input class="in" name="var:{col.header}" value={col.variable} style="width:200px;padding:5px 8px" /></td>
                {/if}
                <td class="rt num">{n(col.stat.filled)} / {n(p.total)}</td>
                <td class="mute" style="font-size:12px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{col.samples.filter(Boolean).join(' · ')}</td>
              </tr>
            {/each}
          </tbody></table></div>
        <span class="help">If there is no firstName column, Hedwig derives it from contactPerson, name or contact.</span>
        {#if form?.error}<div class="flash err">{form.error}</div>{/if}
        <div class="acts"><button class="btn pri" type="submit" disabled={!sel || sel.stat.willImport === 0}>{sel && sel.stat.willImport ? `Import ${plural(sel.stat.willImport, 'lead')}` : 'Import'}</button></div>
      </div>
    </form>
  {/if}
</div>
<style>.grid2.single{grid-template-columns:1fr;max-width:720px}</style>
