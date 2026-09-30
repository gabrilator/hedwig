<script lang="ts">
  import Chart from '$lib/ui/Chart.svelte';
  import { ago, n, pct, pctInt } from '$lib/ui/format';
  let { data } = $props();
  const q = (patch: Record<string, string>) => { const p = new URLSearchParams({ days: String(data.days), campaign: data.campaignId, account: data.accountId, mb: String(data.mb), ...patch }); for (const [k, v] of [...p.entries()]) if (!v) p.delete(k); return '?' + p.toString(); };
</script>
<svelte:head><title>Analytics · Hedwig</title></svelte:head>
<div class="top">
  <div><h1 class="disp">Analytics</h1><div class="sub">everything {data.space?.name} sent, opened and got back</div></div>
  <form class="acts" method="GET">
    <input type="hidden" name="mb" value={data.mb} />
    <select class="in" name="campaign" style="width:auto" onchange={(e) => e.currentTarget.form?.requestSubmit()}><option value="">All campaigns</option>{#each data.campaigns as cp}<option value={cp._id} selected={cp._id === data.campaignId}>{cp.name}</option>{/each}</select>
    <select class="in" name="account" style="width:auto" onchange={(e) => e.currentTarget.form?.requestSubmit()}><option value="">All mailboxes</option>{#each data.accounts as a}<option value={a.id} selected={a.id === data.accountId}>{a.address}</option>{/each}</select>
    <select class="in" name="days" style="width:auto" onchange={(e) => e.currentTarget.form?.requestSubmit()}>{#each [7, 28, 90, 180] as d}<option value={d} selected={d === data.days}>Last {d === 180 ? '6 months' : `${d} days`}</option>{/each}</select>
  </form>
</div>
<div class="kpis">
  <div class="kpi"><div class="lbl">Sent</div><div class="v num">{n(data.totals.sent)}</div><div class="s">last {data.days} days</div></div>
  <div class="kpi"><div class="lbl">Open rate</div><div class="v num">{pctInt(data.totals.uniqueOpens, data.totals.sent).replace('%', '')}<small>%</small></div><div class="s">{n(data.totals.uniqueOpens)} unique opens</div></div>
  <div class="kpi hot"><div class="lbl">Reply rate</div><div class="v num">{pct(data.totals.replies, data.totals.sent).replace('%', '')}<small>%</small></div><div class="s">{n(data.totals.replies)} replies</div></div>
  <div class="kpi" class:warn={data.totals.sent && data.totals.bounces / data.totals.sent >= 0.05}><div class="lbl">Bounce rate</div><div class="v num">{pct(data.totals.bounces, data.totals.sent).replace('%', '')}<small>%</small></div><div class="s">{n(data.totals.bounces)} bounces · alarm at 5%</div></div>
  <div class="kpi hot"><div class="lbl">Opportunities</div><div class="v num">{n(data.opps)}</div><div class="s">interested, meeting or won</div></div>
</div>
<div class="panel">
  <div class="hd"><h3>Per day</h3></div>
  <Chart points={data.points} />
</div>
<div class="grid2" style="margin-top:18px">
  <div class="panel">
    <div class="hd"><h3>Deliverability by mailbox</h3><div class="acts">{#each [7, 14, 28] as d}<a class="btn sm" class:ghost={data.mb !== d} href={q({ mb: String(d) })}>{d}d</a>{/each}<a class="btn sm ghost" href="/emails">manage</a></div></div>
    <div class="wrap cards"><table style="min-width:0">
      <thead><tr><th>Mailbox</th><th>DNS</th><th class="rt">Today</th><th class="rt">Sent {data.mb}d</th><th class="rt">Bounce {data.mb}d</th><th class="rt">Reply {data.mb}d</th><th>Sync</th></tr></thead>
      <tbody>
        {#each data.accounts as a}
          <tr>
            <td class="full nolbl"><span class="nm">{a.address}</span>{#if a.status !== 'active'}<span class="sm r">{a.status}</span>{/if}</td>
            <td data-l="DNS">{#if a.dns}<span class="dns"><b class:bad={!a.dns.spf.ok}>SPF</b><b class:bad={!a.dns.dkim.ok}>DKIM</b><b class:bad={!a.dns.dmarc.ok}>DMARC</b></span>{:else}<span class="dns"><b class="unknown">not checked</b></span>{/if}</td>
            <td data-l="Today" class="rt num">{a.sentToday} / {a.limit}</td>
            <td data-l="Sent {data.mb}d" class="rt num">{n(a.sentWindow)}</td>
            <td data-l="Bounce {data.mb}d" class="rt num" class:r={a.bounceRate !== null && a.bounceRate >= 0.05}>{a.bounceRate === null ? '—' : pct(a.bounceRate * 100, 100)}</td>
            <td data-l="Reply {data.mb}d" class="rt num">{a.replyRate === null ? '—' : pct(a.replyRate * 100, 100)}</td>
            <td data-l="Sync" class="mute">{a.lastError ? `error · ${ago(a.lastSync)}` : ago(a.lastSync)}</td>
          </tr>
          {#if a.dns && a.dns.fixes.length}
            <tr><td colspan="7" class="mute" style="font-size:12px">{#each a.dns.fixes as f}<div>· {f}</div>{/each}</td></tr>
          {/if}
        {:else}
          <tr><td colspan="7" class="mute">No mailbox connected yet.</td></tr>
        {/each}
      </tbody></table></div>
  </div>
  <div class="stack">
    <div class="panel">
      <div class="hd"><h3>Inbound by kind · last {data.days} days</h3></div>
      <div class="bd"><div class="counts" style="margin:0;box-shadow:none"><div><b>{data.kinds.reply ?? 0}</b>replies</div><div><b>{data.kinds.ooo ?? 0}</b>out of office</div><div><b>{data.kinds.bounce ?? 0}</b>bounces</div></div></div>
    </div>
  </div>
</div>
