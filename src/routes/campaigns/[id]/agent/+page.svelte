<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '$lib/ui/motion.svelte';
  import { ago, labelAi, labelStatus } from '$lib/ui/format';
  let { data, form } = $props();
  const cp = $derived(data.campaign);
  $effect(() => { if (form?.saved) { toast('Agent settings saved'); invalidateAll(); } });
</script>
<div class="grid2">
  <form class="panel" method="POST" action="?/save" use:enhance>
    <div class="hd"><h3>Agent on this campaign</h3><span class="light" class:on={data.on && data.spaceAgent.active}><i></i>{data.on ? `${data.spaceAgent.name} ${data.spaceAgent.active ? 'on' : 'off'}` : 'none'}</span></div>
    <div class="bd stack">
      <label class="field" style="flex-direction:row;align-items:center;gap:10px"><input type="checkbox" name="on" checked={data.on} /> <span>{data.spaceAgent.name} reads this campaign's replies</span></label>
      <span class="help">Off: replies are still matched and stop the sequence, but nobody labels them. {data.spaceAgent.name} itself is switched on or off for the whole workspace on the <a href="/agents">Agents</a> screen.</span>
      <div class="acts"><button class="btn pri sm" type="submit">Save</button></div>
    </div>
  </form>
  <div class="stack">
    <div class="aibox" class:off={!data.on || !data.spaceAgent.active || !data.canLabel}>
      <div class="row"><span class="light" class:on={data.on && data.spaceAgent.active && data.canLabel}><i></i>{data.on ? data.spaceAgent.name : 'no agent'}</span><span class="mute">Jev labels</span></div>
      <div>{data.what}</div>
      {#if !data.canLabel}<div class="r">No Jev key on the server: nothing is labelled until <code>TYPESAFE_API_KEY</code> is in the environment (see <a href="/agents">Agents</a>).</div>{/if}
      <div>Labels: meeting, interested, replied. Meeting and interested also set the lead's status when Jev is at least 75% sure, and only from an automatic status. Once you set a lead's status by hand the agent stops labelling that lead (Label again in the Inbox hands it back). Meeting and interested email the campaign owner.</div>
    </div>
    <div class="panel">
      <div class="hd"><h3>Latest labels on this campaign</h3><a class="btn sm ghost" href="/inbox?campaign={cp._id}">open in inbox</a></div>
      <div class="wrap"><table style="min-width:0;font-size:12px"><thead><tr><th>Reply</th><th>Label</th><th>Odds</th></tr></thead><tbody>
        {#each data.recent as r}
          <tr><td><a href="/inbox?thread={r.leadId}" style="text-decoration:none"><b>{r.from}</b></a><span class="sm">{r.subject} · {ago(r.at)}</span></td><td><span class="lab {r.label}">{labelAi(r.label)}</span> <span class="mute num">{Math.round(r.confidence * 100)}%</span>{#if r.appliedStatus}<span class="sm">marked {labelStatus(r.appliedStatus)}</span>{/if}</td><td class="mute" style="font-family:var(--sans)">{r.reason}</td></tr>
        {:else}
          <tr><td colspan="3" class="mute">No reply labelled yet. Each new reply is read once, within two minutes of arriving.</td></tr>
        {/each}
      </tbody></table></div>
    </div>
  </div>
</div>
