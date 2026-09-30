<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll, replaceState } from '$app/navigation';
  import { ago, fmtDT, pct } from '$lib/ui/format';
  import { fly, toast } from '$lib/ui/motion.svelte';
  import Owl from '$lib/ui/Owl.svelte';
  import Info from '$lib/ui/Info.svelte';
  import TimezoneSelect from '$lib/ui/TimezoneSelect.svelte';
  let { data, form } = $props();
  let editing = $state<string | null>(null);
  let busy = $state('');
  const run = (key: string) => () => { busy = key; return async ({ update }: any) => { busy = ''; await update({ reset: false }); }; };
  $effect(() => { if (form?.note) { toast(form.note); invalidateAll(); } if (form?.error) toast(form.error, 'err', 6000); });
  $effect(() => { if (data.connected) { fly(`${data.connected} connected · reading replies from now on`); replaceState('/emails', {}); } });
</script>
<svelte:head><title>Emails · Hedwig</title></svelte:head>
<div class="top">
  <div><h1 class="disp">Emails</h1><div class="sub">the mailboxes Hedwig sends from and reads replies in · {data.space?.name}</div></div>
  <div class="acts">
    <a class="btn pri" href="/emails/new">+ Connect a mailbox (IMAP / SMTP)</a>
    {#if data.msConfigured}<a class="btn" href="/emails/microsoft/start">Connect with Microsoft</a>{/if}
    <Info label="How mailboxes connect">
      <p style="margin:0 0 8px"><b>Any provider with IMAP and SMTP</b> (Titan, Zoho, Google, IONOS, Hostinger, your own server) connects with the mailbox password through “Connect a mailbox”.</p>
      <p style="margin:0 0 8px"><b>Microsoft 365 is the one exception.</b> Microsoft stopped accepting passwords over IMAP in 2022, so those mailboxes connect through a Microsoft consent screen. That needs a one-time app registration on your side (an Entra app, <code>MS_CLIENT_ID</code> + <code>MS_CLIENT_SECRET</code> in the environment), described in the README; the button appears here once the two values are set.</p>
    </Info>
  </div>
</div>
{#if data.msError}<div class="flash err">Microsoft connection failed: {data.msError}</div>{/if}

{#if data.accounts.length === 0}
  <div class="empty"><Owl size={80} /><div>No mailbox connected in {data.space?.name}.</div><div class="mute" style="font-size:12px">Hedwig never sends from its own server. Connect the mailbox the emails should come from.</div></div>
{:else}
  <div class="wrap cards">
    <table>
      <thead><tr><th>Mailbox</th><th class="rt">Today</th><th class="rt">Bounce 7d</th><th class="rt">Reply 7d</th><th>DNS</th><th>Inbox sync</th><th>Status</th><th></th></tr></thead>
      <tbody>
        {#each data.accounts as a}
          <tr>
            <td class="full nolbl"><span class="nm">{a.address}</span><span class="sm">{a.kind === 'microsoft' ? 'Microsoft 365 · connected with Microsoft' : `${a.host} · IMAP/SMTP`} · {a.campaigns} campaign{a.campaigns === 1 ? '' : 's'}{#if a.ramp?.enabled && a.limit < a.dailyLimit} · ramping {a.limit} → {a.dailyLimit}/day{/if}</span></td>
            <td data-l="Today" class="rt num" title="since midnight in {a.zone}">{a.sentToday} / {a.limit}</td>
            <td data-l="Bounce 7d" class="rt num">{a.bounceRate7d === null ? '—' : pct(a.bounceRate7d * 100, 100)}</td>
            <td data-l="Reply 7d" class="rt num">{a.replyRate7d === null ? '—' : pct(a.replyRate7d * 100, 100)}</td>
            <td data-l="DNS">{#if a.dns}<span class="dns" title={a.dns.fixes.join('\n')}><b class:bad={!a.dns.spf.ok}>SPF</b><b class:bad={!a.dns.dkim.ok}>DKIM</b><b class:bad={!a.dns.dmarc.ok}>DMARC</b></span>{:else}<span class="dns"><b class="unknown">pending</b></span>{/if}</td>
            <td data-l="Inbox sync" class:r={!!a.lastError}>{a.lastError ? `error · ${ago(a.lastSync)}` : ago(a.lastSync)}</td>
            <td data-l="Status"><span class="pill {a.status}">{a.status}</span></td>
            <td class="rt nolbl"><button class="btn sm ghost" onclick={() => (editing = editing === a.id ? null : a.id)}>{editing === a.id ? 'Close' : 'Manage'}</button></td>
          </tr>
          {#if a.pausedReason || a.lastError || (a.dns && a.dns.fixes.length)}
            <tr><td colspan="8" style="font-size:12px" class="mute">
              {#if a.pausedReason}<div class="r">{a.pausedReason}</div>{/if}
              {#if a.lastError}<div class="r">Last sync error: {a.lastError}</div>{/if}
              {#if a.dns}{#each a.dns.fixes as f}<div>· {f}</div>{/each}{/if}
            </td></tr>
          {/if}
          {#if editing === a.id}
            <tr><td colspan="8">
              <div class="stack">
                <form class="acts" method="POST" action="?/limit" use:enhance>
                  <input type="hidden" name="id" value={a.id} />
                  <label class="field"><span class="lbl">From name</span><input class="in" name="fromName" value={a.fromName} style="width:200px" /></label>
                  <label class="field"><span class="lbl">Daily limit</span><input class="in num" name="dailyLimit" type="number" min="1" max="500" value={a.dailyLimit} style="width:100px" /></label>
                  <label class="field"><span class="lbl">Pause itself at</span><span class="acts" style="gap:6px"><input class="in num" name="bouncePausePct" type="number" min="0" max="100" step="0.5" value={a.bouncePausePct} style="width:80px" /><span class="mute">% bounces</span></span><span class="help">Over the last 7 days, once there are 20 sends and 2 bounces. 0 = never pause by itself.</span></label>
                  <label class="field"><span class="lbl">Ramp</span><label class="chip" style="cursor:pointer"><input type="checkbox" name="ramp" checked={a.ramp?.enabled} /> new mailbox: 10/day, +5 a week</label></label>
                  <label class="field" style="min-width:260px"><span class="lbl">Day resets at midnight in</span><TimezoneSelect zones={data.timezones} value={a.timezone} required={false} /><span class="help">The daily limit counts from this midnight. Set from the first campaign that used the mailbox.</span></label>
                  <div class="field"><span class="lbl">&nbsp;</span><button class="btn sm pri" type="submit">Save</button></div>
                </form>
                <div class="acts">
                  <form method="POST" action="?/test" use:enhance={run(`test:${a.id}`)}><input type="hidden" name="id" value={a.id} /><button class="btn sm" disabled={busy === `test:${a.id}`}>{busy === `test:${a.id}` ? 'Testing…' : 'Test connection'}</button></form>
                  <form method="POST" action="?/sync" use:enhance={run(`sync:${a.id}`)}><input type="hidden" name="id" value={a.id} /><button class="btn sm" disabled={busy === `sync:${a.id}`}>{busy === `sync:${a.id}` ? 'Queued…' : 'Sync inbox now'}</button></form>
                  <form method="POST" action="?/dns" use:enhance={run(`dns:${a.id}`)}><input type="hidden" name="id" value={a.id} /><button class="btn sm" disabled={busy === `dns:${a.id}`}>{busy === `dns:${a.id}` ? 'Queued…' : 'Re-check DNS'}</button></form>
                  {#if a.status === 'active'}<form method="POST" action="?/pause" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn sm ghost">Pause</button></form>{:else}<form method="POST" action="?/resume" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn sm blue">Resume</button></form>{/if}
                  <form method="POST" action="?/delete" use:enhance onsubmit={(e) => { if (!confirm(`Remove ${a.address}?`)) e.preventDefault(); }}><input type="hidden" name="id" value={a.id} /><button class="btn sm ghost">Remove</button></form>
                </div>
                {#if a.campaignNames.length}<div class="lbl">used by: {a.campaignNames.join(', ')}</div>{/if}
              </div>
            </td></tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

