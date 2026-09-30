<script lang="ts">
  import { enhance } from '$app/forms';
  import Owl from '$lib/ui/Owl.svelte';
  import TimezoneSelect from '$lib/ui/TimezoneSelect.svelte';
  import { fmtTime, n, pctInt } from '$lib/ui/format';
  let { data, form } = $props();
  let creating = $state(false);
</script>
<svelte:head><title>Campaigns · Hedwig</title></svelte:head>

<div class="top">
  <div><h1 class="disp">Campaigns</h1><div class="sub">{data.space?.name} · {data.campaigns.length} campaigns · {data.ticker.accounts} mailboxes</div></div>
  <div class="acts"><button class="btn pri" onclick={() => (creating = !creating)}>+ New campaign</button></div>
</div>

{#if creating}
  <form class="panel" method="POST" action="?/create" use:enhance style="margin-bottom:18px">
    <div class="hd"><h3>New campaign</h3></div>
    <div class="bd frow">
      <label class="field"><span class="lbl">Name</span><input class="in" name="name" placeholder="October outreach" required /></label>
      <label class="field"><span class="lbl">Timezone for the sending window</span><TimezoneSelect zones={data.timezones} /><span class="help">Emails go out 09:00–15:00 on weekdays in this zone; change it any time in Schedule.</span></label>
      <div class="field"><span class="lbl">&nbsp;</span><button class="btn pri" type="submit">Create and upload the list</button></div>
    </div>
    {#if form?.error}<div class="bd"><div class="flash err">{form.error}</div></div>{/if}
  </form>
{/if}

<div class="ticker">
  <span>last 24 h <b>{data.ticker.sent24}</b> sent · <b>{data.ticker.opens24}</b> opens · <b>{data.ticker.replies24}</b> replies</span>
  {#if data.ticker.nextSend}<span><Owl size={18} /> next send <b>{fmtTime(data.ticker.nextSend.at)}</b> from {data.ticker.nextSend.account}</span>{/if}
  {#each data.ticker.activeWindows as w}<span>{w}</span>{/each}
</div>

{#if data.campaigns.length === 0}
  <div class="empty"><Owl size={80} /><div>No campaigns in {data.space?.name} yet.</div><div class="mute" style="font-size:12px">Create one, upload the list, write the steps, pick a mailbox in Options, activate.</div></div>
{:else}
  <div class="wrap cards">
    <table>
      <thead><tr><th>Name</th><th>Status</th><th>Progress</th><th class="rt">Leads</th><th class="rt" title="Emails sent, follow-ups included">Sent</th><th class="rt" title="Emails opened at least once, as a share of emails sent. Some mail servers and apps load images when an email arrives, without anyone reading it, so opens run high; replies are the reliable number.">Opened</th><th class="rt" title="Replies, as a share of the people contacted">Replied</th><th class="rt">Opps</th><th>Mailboxes</th><th></th></tr></thead>
      <tbody>
        {#each data.campaigns as cp}
          <tr class="row" onclick={() => (location.href = `/campaigns/${cp.id}/analytics`)}>
            <td class="full nolbl"><a class="nm" href="/campaigns/{cp.id}/analytics" style="text-decoration:none">{cp.name}</a><span class="sm">{cp.steps} step{cp.steps === 1 ? '' : 's'} · {cp.timezone}{#if cp.windowNote} · {cp.windowNote}{/if}{#if cp.agent?.on} · <span class="g">● {cp.agent.name}</span>{:else if cp.agent} · <span class="mute">○ {cp.agent.name} off</span>{:else} · <span class="mute">○ no agent</span>{/if}</span></td>
            <td data-l="Status"><span class="pill {cp.status}">{cp.status}</span></td>
            <td data-l="Progress"><div class="pw"><div class="bar" class:done={cp.status === 'completed'}><i style="--p:{cp.progress}%"></i></div><span class="num">{cp.progress}%</span></div></td>
            <td class="rt num" data-l="Leads">{n(cp.leads)}</td>
            <td class="rt num" data-l="Sent">{n(cp.sent)}</td>
            <td class="rt num" data-l="Opened">{cp.opens} <span class="mute">· {pctInt(cp.opens, cp.sent)}</span></td>
            <td class="rt num" data-l="Replied"><b>{cp.replies}</b> <span class="mute">· {pctInt(cp.replies, cp.contacted)}</span></td>
            <td class="rt num" data-l="Opps"><span class="y">{cp.opps}</span></td>
            <td data-l="Mailboxes">{#each cp.accounts as a}<span class="chip">{a}</span> {/each}{#if !cp.accounts.length}<span class="chip add">none yet</span>{/if}</td>
            <td class="rt nolbl"><form method="POST" action="?/duplicate" use:enhance><input type="hidden" name="id" value={cp.id} /><button class="btn sm ghost" type="submit" onclick={(e) => e.stopPropagation()} title="A new draft with the same steps, schedule, mailboxes and options. No leads.">Duplicate</button></form></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
