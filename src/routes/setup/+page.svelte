<script lang="ts">
  import Feed from '$lib/ui/Feed.svelte';
  let { data, form } = $props();
</script>
<svelte:head><title>Setup · Hedwig</title></svelte:head>
<div class="top"><div><h1 class="disp">Setup</h1><div class="sub">settings for this workspace · assistant connections are under <a href="/connections">MCP</a></div></div></div>
{#if data.masterKeyProblem}
  <div class="note red" style="margin-bottom:16px"><b>{data.masterKeyProblem}</b> It is the key that encrypts mailbox passwords and Microsoft tokens at rest. Generate one with <code>node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"</code>, put it in the environment as <code>HEDWIG_MASTER_KEY</code>, redeploy. Never change it once mailboxes are connected: they would become unreadable.</div>
{/if}
<div class="grid2">
  <div class="stack">
    <Feed {data} {form} />
  </div>
  <div class="stack" style="align-self:start">
    {#if data.worker}
      <div class="panel"><div class="hd"><h3>Worker</h3><span class="light" class:on={!data.worker.stale}><i></i>{data.worker.stale ? 'Offline' : 'Running'}{#if data.worker.ageSec !== null} · {data.worker.ageSec}s ago{/if}</span></div></div>
    {/if}
  </div>
</div>
