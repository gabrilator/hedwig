<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '$lib/ui/motion.svelte';
  import { ago } from '$lib/ui/format';
  let { data, form } = $props();
  $effect(() => { if (form?.saved) { toast('Saved'); invalidateAll(); } if (form?.error) toast(form.error, 'err', 6000); });
</script>
<svelte:head><title>Agents · Hedwig</title></svelte:head>
<div class="top">
  <div><h1 class="disp">Agents</h1><div class="sub">Jev reads every reply once and labels it meeting, interested or replied · nothing is ever sent by an agent · admins only</div></div>
  <div class="acts"><span class="light" class:on={data.llm.configured}><i></i>{data.llm.configured ? `Jev on · ${data.llm.today} calls today` : 'no Jev key'}</span></div>
</div>
{#if !data.llm.configured}<div class="note red" style="margin-bottom:16px"><b>No Jev key on the server.</b> Replies are matched and stop the sequence, but nothing is labelled until <code>TYPESAFE_API_KEY</code> is in the server's environment. Get a key in the TypeSafe console (console.typesafe.ai → API keys), add it, restart.</div>{/if}
<div class="grid2">
  <form class="panel" method="POST" action="?/save" use:enhance>
    <div class="hd"><h3>{data.agent.name} · {data.space?.name}</h3><label class="chip" style="cursor:pointer"><input type="checkbox" name="active" checked={data.agent.active} /> on</label></div>
    <div class="bd stack">
      <label class="field"><span class="lbl">Name</span><input class="in" name="name" value={data.agent.name} maxlength="60" required /></label>
      <p class="help" style="margin:0">One agent per workspace. Every campaign here uses it ({data.campaignsOn} now{#if data.campaignsOff}, {data.campaignsOff} with it switched off on the campaign{/if}). Meeting and interested replies set the lead's status when Jev is at least 75% sure, and email the campaign owner. Replied changes nothing.</p>
      <div class="acts"><button class="btn pri sm" type="submit">Save</button></div>
    </div>
  </form>
  <div class="panel">
    <div class="hd"><h3>Jev</h3><span class="light" class:on={data.llm.configured}><i></i>{data.llm.configured ? 'key set' : 'no key'}</span></div>
    <div class="bd stack" style="font-size:12px;color:var(--mute);line-height:1.6;gap:10px">
      <div class="counts" style="margin:0;box-shadow:none"><div><b>{data.llm.today}</b>calls today</div><div><b>{data.llm.month}</b>last 30 days</div><div><b>{data.llm.pending}</b>replies waiting</div><div><b>{data.llm.cap}</b>cap per day</div></div>
      {#if data.llm.failedToday}<p style="margin:0" class="r">{data.llm.failedToday} failed call{data.llm.failedToday === 1 ? '' : 's'} today.</p>{/if}
      {#if data.llm.lastError}<p style="margin:0">Last error ({ago(data.llm.lastError.at)}): <code>{data.llm.lastError.error}</code></p>{/if}
      <p style="margin:0">Counts are for the whole server. The cap is <code>JEV_DAILY_CAP</code> (300 when unset).</p>
    </div>
  </div>
</div>
