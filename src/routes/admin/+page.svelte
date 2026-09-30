<script lang="ts">
  import { ago, fmtDT, n } from '$lib/ui/format';
  let { data } = $props();
  const max = $derived(Math.max(1, ...data.perDay.map((d) => d.n)));
</script>
<svelte:head><title>Admin · Hedwig</title></svelte:head>

<div class="top">
  <div><h1 class="disp">Admin</h1><div class="sub">every account on this server · only the addresses in ADMIN_EMAILS see this page</div></div>
</div>

<div class="kpis">
  <div class="kpi"><div class="lbl">Accounts</div><div class="v num">{n(data.total)}</div><div class="s">all time</div></div>
  <div class="kpi hot"><div class="lbl">Last 24 h</div><div class="v num">{n(data.last24)}</div><div class="s">new sign-ups</div></div>
  <div class="kpi"><div class="lbl">Last 7 days</div><div class="v num">{n(data.last7)}</div><div class="s">new sign-ups</div></div>
  <div class="kpi"><div class="lbl">Last 30 days</div><div class="v num">{n(data.last30)}</div><div class="s">new sign-ups</div></div>
</div>

<div class="panel" style="margin-bottom:18px">
  <div class="hd"><h3>Sign-ups per day</h3><span class="lbl">last 30 days, UTC · highest {max}</span></div>
  <div class="bd">
    <div class="signbars" role="img" aria-label="Sign-ups per day over the last 30 days">
      {#each data.perDay as d}<i class:zero={d.n === 0} style:height="{d.n ? Math.max(6, (d.n / max) * 100) : 3}%" title="{d.day}: {d.n}"></i>{/each}
    </div>
    <div class="signaxis lbl"><span>{data.perDay[0].day}</span><span>today</span></div>
  </div>
</div>

<div class="wrap cards">
  <table>
    <thead><tr><th>Account</th><th>Joined</th><th>Last login</th><th class="rt">Mailboxes</th><th class="rt">Campaigns</th><th class="rt">Active</th><th class="rt">Sent, 30 days</th></tr></thead>
    <tbody>
      {#each data.rows as r}
        <tr>
          <td class="full nolbl"><span class="nm">{r.email}</span><span class="sm">{r.name}</span></td>
          <td data-l="Joined" style="white-space:nowrap">{fmtDT(r.joined)}</td>
          <td data-l="Last login" class="mute" style="white-space:nowrap">{r.lastLogin ? ago(r.lastLogin) : 'never'}</td>
          <td class="rt num" data-l="Mailboxes">{r.mailboxes}</td>
          <td class="rt num" data-l="Campaigns">{r.campaigns}</td>
          <td class="rt num" data-l="Active">{#if r.active}<span class="g">{r.active}</span>{:else}0{/if}</td>
          <td class="rt num" data-l="Sent, 30 days">{n(r.sent30)}</td>
        </tr>
      {:else}
        <tr><td colspan="7" class="mute">No accounts yet.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
{#if data.total > data.rows.length}<p class="mute" style="font-size:12px;margin-top:10px">The latest {data.rows.length} of {n(data.total)} accounts.</p>{/if}

<style>
  .signbars { display: flex; align-items: flex-end; gap: 3px; height: 96px; border-bottom: 1px solid var(--line); }
  .signbars i { flex: 1; background: var(--blue); }
  .signbars i.zero { background: var(--line); }
  .signaxis { display: flex; justify-content: space-between; margin-top: 6px; }
</style>
