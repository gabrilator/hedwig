<script lang="ts">
  let { data, form } = $props();
  let emailColumn = $state('');
  $effect(() => { emailColumn = data.preview?.emailColumn ?? ''; });
</script>
<svelte:head><title>Upload list · Hedwig</title></svelte:head>
<div class="top"><h1>Upload list</h1><a href="/lists">← Lists</a></div>
{#if form?.error}<p class="flash err">{form.error}</p>{/if}
{#if !data.preview}
<form class="panel bd stack" method="POST" action="?/upload" enctype="multipart/form-data">
<label class="field">CSV or Excel file<input class="in" type="file" name="file" accept=".csv,.xlsx,.xls" required/></label>
<p class="mute">One header row. Up to 10,000 contacts, 50 columns and 10 MB.</p><button class="btn pri">Upload and choose columns</button>
</form>
{:else}
<form class="panel bd stack" method="POST" action="?/confirm">
<input type="hidden" name="import" value={data.preview.id}/>
<label class="field">List name<input class="in" name="name" value={data.preview.name} required maxlength="200"/></label>
<label class="field">Email column<select class="in" name="emailColumn" bind:value={emailColumn} required><option value="">Choose a column</option>{#each data.preview.columns as col}<option value={col.header}>{col.header}</option>{/each}</select></label>
<p>{data.preview.total} rows. Duplicate emails and invalid addresses are skipped. Existing contact values are preserved.</p>
<div class="wrap"><table><thead><tr><th>Keep</th><th>Column</th><th>Email variable</th><th>Preview</th></tr></thead><tbody>
{#each data.preview.columns as col}<tr><td>{#if col.header !== emailColumn}<input type="checkbox" name="keep" value={col.header} checked aria-label="Keep {col.header}"/>{:else}✓{/if}</td><td>{col.header}</td><td>{#if col.header !== emailColumn}<input class="in" name="var:{col.header}" value={col.variable} aria-label="Variable for {col.header}"/>{:else}Email address{/if}</td><td>{col.samples.join(' · ')}</td></tr>{/each}
</tbody></table></div><button class="btn pri" disabled={!emailColumn}>Create list</button>
</form>
{/if}
