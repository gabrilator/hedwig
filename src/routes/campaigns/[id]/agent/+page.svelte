<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '$lib/ui/motion.svelte';
  import { ago, labelAi, labelStatus } from '$lib/ui/format';
  let { data, form } = $props();
  const cp = $derived(data.campaign);
  let rules = $state<{ if: string; then: string }[]>([]);
  $effect(() => { rules = cp.agentRules.map((r: any) => ({ ...r })); });
  $effect(() => { if (form?.saved) { toast('Agent settings saved'); invalidateAll(); } });
</script>
<div class="grid2">
  <form class="panel" method="POST" action="?/save" use:enhance>
    <div class="hd"><h3>Agent on this campaign</h3><span class="light" class:on={data.agent?.active}><i></i>{data.agent ? `${data.agent.name} ${data.agent.active ? 'on' : 'off'}` : 'none'}</span></div>
    <div class="bd stack">
      <label class="field"><span class="lbl">Which agent reads the replies</span>
        <select class="in" name="choice">
          <option value="default" selected={data.choice === 'default'}>Triage · built in · every campaign without a choice of its own</option>
          {#each data.agents.filter((a: any) => !a.builtin) as a}<option value={a.id} selected={data.choice === a.id}>{a.name} · {a.model} · {a.mode === 'draft' ? 'classify + draft' : 'classify'}{a.active ? '' : ' · switched off'}</option>{/each}
          <option value="none" selected={data.choice === 'none'}>None · replies are matched and stopped, never labelled</option>
        </select>
        <span class="help">Agents are defined on the Agents screen (who they are, which model writes drafts, classify only or classify + draft, on or off). The rules below are this campaign's own and shape the drafts.</span>
      </label>
      <div class="field"><span class="lbl">Rules for drafts</span>
        {#each rules as r, i}
          <div class="rule"><span class="kw">when</span><input class="in" name="if" bind:value={r.if} /><span class="kw">then</span><input class="in" name="then" bind:value={r.then} /><button type="button" class="linkbtn mute" onclick={() => rules.splice(i, 1)} aria-label="remove rule">✕</button></div>
        {/each}
        <div><button type="button" class="btn sm ghost" onclick={() => rules.push({ if: '', then: '' })}>+ rule</button></div>
        <span class="help">Used only when the agent writes a draft. A draft is text in the Inbox for you to edit and send; the agent never sends anything to a lead.</span>
      </div>
      <div class="acts"><button class="btn pri sm" type="submit">Save</button></div>
    </div>
  </form>
  <div class="stack">
    <div class="aibox" class:off={!data.agent?.active || !data.canLabel}>
      <div class="row"><span class="light" class:on={data.agent?.active && data.canLabel}><i></i>{data.agent ? data.agent.name : 'no agent'}</span>{#if data.agent}<span class="mute">{data.jev ? `Jev labels${data.agent.mode === 'draft' ? ` · ${data.agent.model} drafts` : ''}` : `${data.agent.model} · ${data.agent.mode === 'draft' ? 'classify + draft' : 'classify only'}`}</span>{/if}</div>
      <div>{data.what}</div>
      {#if !data.canLabel}<div class="r">No model key on the server: nothing is labelled until <code>TYPESAFE_API_KEY</code> (Jev) or <code>GEMINI_API_KEY</code> is set (see <a href="/setup">setup</a>).</div>{/if}
      <div>Labels: interested, meeting, question, not interested, out of office, bounce, unsubscribe, other. Interested, meeting, not interested and unsubscribe also set the lead's status when the agent is at least 75% sure, and only from an automatic status. Once you set a lead's status by hand the agent stops labelling that lead (Label again in the Inbox hands it back). Interested and meeting email the campaign owner.</div>
    </div>
    <div class="panel">
      <div class="hd"><h3>Latest labels on this campaign</h3><a class="btn sm ghost" href="/inbox?campaign={cp._id}">open in inbox</a></div>
      <div class="wrap"><table style="min-width:0;font-size:12px"><thead><tr><th>Reply</th><th>Label</th><th>Why</th></tr></thead><tbody>
        {#each data.recent as r}
          <tr><td><a href="/inbox?thread={r.leadId}" style="text-decoration:none"><b>{r.from}</b></a><span class="sm">{r.subject} · {ago(r.at)}</span></td><td><span class="lab {r.label}">{labelAi(r.label)}</span> <span class="mute num">{Math.round(r.confidence * 100)}%</span>{#if r.appliedStatus}<span class="sm">marked {labelStatus(r.appliedStatus)}</span>{/if}</td><td class="mute" style="font-family:var(--sans)">{r.reason}</td></tr>
        {:else}
          <tr><td colspan="3" class="mute">No reply labelled yet. Each new reply is read once, within two minutes of arriving.</td></tr>
        {/each}
      </tbody></table></div>
    </div>
  </div>
</div>
