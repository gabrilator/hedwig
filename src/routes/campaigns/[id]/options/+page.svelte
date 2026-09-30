<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '$lib/ui/motion.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  let { data, form } = $props();
  const cp = $derived(data.campaign);
  $effect(() => { if (form?.saved) { toast('Options saved'); invalidateAll(); } });
</script>
{#if form?.error}<div class="flash err" role="alert">{form.error}</div>{/if}
{#if form?.resolved}<div class="flash ok" role="status">{form.resolved}</div>{/if}
{#if data.conflicts}
  <section class="panel" style="margin-bottom:18px" aria-label="Contacts in other active campaigns">
    <div class="hd"><h3>Resolve {data.conflicts} overlapping contact{data.conflicts === 1 ? '' : 's'}</h3></div>
    <div class="bd stack">
      <p>Choose which campaign should continue outreach to each contact, then resume this campaign.</p>
      {#each data.conflictingContacts as contact}
        <div class="stack" style="padding:12px 0;border-bottom:1px solid var(--line)">
          <a href="/campaigns/{cp._id}/leads?lead={contact.leadId}">{contact.email}</a>
          <div>Also active in: {#each contact.campaigns as other, i}{#if i > 0}, {/if}<a href="/campaigns/{other.id}/leads?lead={other.leadId}">{other.name}</a>{/each}</div>
          <form method="POST" action="?/resolveConflict" class="acts" use:enhance>
            <input type="hidden" name="lead" value={contact.leadId} />
            <button class="btn sm" name="choice" value="keep">Keep here · pause elsewhere</button>
            <button class="btn sm ghost" name="choice" value="remove">Remove from this campaign</button>
          </form>
          <small class="mute">Keeping here pauses only this contact in the other active campaigns and preserves their history. Removing here leaves the other campaigns unchanged.</small>
        </div>
      {/each}
      {#if data.conflicts > data.conflictingContacts.length}<p>Showing the first {data.conflictingContacts.length}. More contacts will appear as these are resolved.</p>{/if}
    </div>
  </section>
{/if}
<form class="panel" method="POST" action="?/save" use:enhance>
  <div class="opt"><div><div class="t">Name</div></div><div class="ctl"><input class="in" name="name" value={cp.name} style="width:320px" /></div></div>
  <div class="opt"><div><div class="t">Sending mailboxes</div><div class="d">Leads are split across these mailboxes and pinned to one for the whole sequence. Each mailbox keeps its own daily limit.</div></div>
    <div class="ctl" style="flex-direction:column;align-items:flex-end;gap:6px">
      {#each data.accounts as a}
        <label class="chip" style="cursor:pointer"><input type="checkbox" name="accountIds" value={a._id} checked={cp.accountIds.includes(a._id)} /> {a.address} <span class="mute">· {a.dailyLimit}/day{a.status !== 'active' ? ` · ${a.status}` : ''}</span></label>
      {:else}
        <a class="chip add" href="/emails">no mailbox yet · connect one</a>
      {/each}
    </div>
  </div>
  <div class="opt"><div><div class="t">Stop on reply</div><div class="d">Any reply from the lead cancels the remaining steps.</div></div><div class="ctl"><Toggle name="stopOnReply" checked={cp.stopOnReply} /></div></div>
  <div class="opt"><div><div class="t">Out-of-office counts as a reply</div><div class="d">Auto-replies are detected by their headers. Off means the sequence continues after the person is back.</div></div><div class="ctl"><Toggle name="oooStops" checked={cp.oooStops} /></div></div>
  <div class="opt"><div><div class="t">Open tracking</div><div class="d">A one-pixel image per email, served from your tracking host. Counted once per email. Some gateways block it; Apple Mail fires it without a human.</div></div><div class="ctl"><Toggle name="openTracking" checked={cp.openTracking} /></div></div>
  <div class="opt"><div><div class="t">Daily limit for this campaign</div><div class="d">Across all its mailboxes. Each mailbox limit still applies on top.</div></div><div class="ctl"><input class="in num" name="dailyLimit" type="number" min="1" value={cp.dailyLimit} /></div></div>
  <div class="opt"><div><div class="t">Test recipient</div><div class="d">Where “Send test” delivers. Never a lead.</div></div><div class="ctl"><input class="in" name="testRecipient" type="email" style="width:260px" value={cp.testRecipient} /></div></div>
  <div class="opt"><div><div class="t">Unsubscribe line</div><div class="d">Optional text appended to every step with an unsubscribe link. Empty = nothing visible in the email; mail clients still get the invisible List-Unsubscribe header (on IMAP/SMTP mailboxes), so Gmail and Outlook show their own unsubscribe link. A click puts the address on the suppression list for the whole space.</div></div><div class="ctl"><input class="in" name="unsubscribeLine" style="width:360px" value={cp.unsubscribeLine} /></div></div>
  <div class="opt"><div></div><div class="ctl"><button class="btn pri" type="submit">Save options</button></div></div>
</form>
<div class="panel" style="margin-top:18px">
  <div class="opt"><div><div class="t">Campaign state · <span class="pill {cp.status}">{cp.status}</span></div><div class="d">Pause cancels today's booked sends; resume books again at the next tick. Duplicate makes a new draft with the same steps, schedule, mailboxes and options, and no leads.</div></div>
    <div class="ctl">
      {#if cp.status === 'draft'}<form method="POST" action="?/activate"><button class="btn pri" disabled={data.problems.length > 0} title={data.problems.join(' ')}>Activate</button></form>{/if}
      {#if cp.status === 'active'}<form method="POST" action="?/pause"><button class="btn">Pause</button></form>{/if}
      {#if cp.status === 'paused' || cp.status === 'completed'}<form method="POST" action="?/resume"><button class="btn blue">{cp.status === 'completed' ? 'Reopen' : 'Resume'}</button></form>{/if}
      <form method="POST" action="?/clone"><button class="btn ghost" title="A new draft with the same steps, schedule, mailboxes and options. No leads.">Duplicate</button></form>
    </div>
  </div>
  <div class="opt"><div><div class="t r">Delete campaign</div><div class="d">Leads, stats and booked sends go with it. Sent emails stay in your mailbox.</div></div><div class="ctl"><form method="POST" action="?/delete" onsubmit={(e) => { if (!confirm(`Delete "${cp.name}" and its ${data.counts.total} leads?`)) e.preventDefault(); }}><button class="btn sm ghost">Delete…</button></form></div></div>
</div>
