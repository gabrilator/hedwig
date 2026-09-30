<script lang="ts">
  import { ago } from '$lib/ui/format';
  import Connections from '$lib/ui/Connections.svelte';
  let { data, form } = $props();
</script>
<svelte:head><title>Setup · Hedwig</title></svelte:head>
<div class="top"><div><h1 class="disp">Setup</h1><div class="sub">connections and settings</div></div></div>
{#if data.masterKeyProblem}
  <div class="note red" style="margin-bottom:16px"><b>{data.masterKeyProblem}</b> It is the key that encrypts mailbox passwords and Microsoft tokens at rest. Generate one with <code>node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"</code>, put it in the environment as <code>HEDWIG_MASTER_KEY</code>, redeploy. Never change it once mailboxes are connected: they would become unreadable.</div>
{/if}
<div class="grid2">
  <div class="stack">
    <div class="panel">
      <div class="hd"><h3>Reply agent</h3><span class="acts" style="gap:12px"><span class="light" class:on={data.llm.jev}><i></i>Jev {data.llm.jev ? 'labels' : 'off'}</span><span class="light" class:on={data.llm.gemini}><i></i>Gemini {data.llm.gemini ? (data.llm.jev ? 'drafts' : 'labels + drafts') : 'off'}</span></span></div>
      <div class="bd stack" style="font-size:12px;color:var(--mute);line-height:1.6;gap:10px">
        {#if !data.llm.configured}
          <div class="note red"><b>No model key on the server.</b> Replies are matched and stopped but not labelled until one is in the server's environment: <code>TYPESAFE_API_KEY</code> (Jev, from console.typesafe.ai → API keys) labels replies, <code>GEMINI_API_KEY</code> (aistudio.google.com → API keys) writes drafts and labels when Jev is not set. Restart after adding one.</div>
        {:else if !data.llm.gemini}
          <p style="margin:0">Jev labels replies. Drafts, and a stand-in when Jev can't answer, need <code>GEMINI_API_KEY</code> (aistudio.google.com → API keys).</p>
        {:else}
          <p style="margin:0">Jev labels replies. When it can't answer (a rejected key, no room, an outage) Gemini labels that reply instead. Gemini writes the drafts.</p>
        {/if}
        <div class="counts" style="margin:0;box-shadow:none"><div><b>{data.llm.today}</b>calls today</div><div><b>{data.llm.month}</b>last 30 days</div><div><b>{data.llm.pending}</b>replies waiting</div><div><b>{data.llm.cap}</b>cap per day</div></div>

        {#if data.llm.failedToday}<p style="margin:0" class="r">{data.llm.failedToday} failed call{data.llm.failedToday === 1 ? '' : 's'} today.</p>{/if}
        {#if data.llm.lastError}<p style="margin:0">Last error ({ago(data.llm.lastError.at)}): <code>{data.llm.lastError.error}</code></p>{/if}
      </div>
    </div>
    <Connections {data} {form} />
  </div>
  {#if data.worker}
    <div class="panel" style="align-self:start"><div class="hd"><h3>Worker</h3><span class="light" class:on={!data.worker.stale}><i></i>{data.worker.stale ? 'Offline' : 'Running'}{#if data.worker.ageSec !== null} · {data.worker.ageSec}s ago{/if}</span></div></div>
  {/if}
</div>
