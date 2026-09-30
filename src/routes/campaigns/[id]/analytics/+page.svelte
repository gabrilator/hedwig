<script lang="ts">
  import Chart from '$lib/ui/Chart.svelte';
  import { n, pct, pctInt } from '$lib/ui/format';
  let { data } = $props();
  const contacted = $derived(data.counts.total - data.counts.queued);
  const opps = $derived(data.counts.interested + data.counts.meeting + data.counts.won);
</script>
<div class="kpis">
  <div class="kpi"><div class="lbl">Leads</div><div class="v num">{n(data.counts.total)}</div><div class="s">{n(contacted)} contacted · {n(data.counts.queued)} queued</div></div>
  <div class="kpi"><div class="lbl">Sent</div><div class="v num">{n(data.totals.sent)}</div><div class="s">{data.byStep.map((s: any) => `step ${s.key + 1}: ${s.sent}`).join(' · ') || 'nothing yet'}</div></div>
  <div class="kpi"><div class="lbl">Opened</div><div class="v num">{pctInt(data.totals.uniqueOpens, data.totals.sent).replace('%', '')}<small>%</small></div><div class="s">{data.totals.uniqueOpens} unique of {data.totals.sent} sent</div></div>
  <div class="kpi hot"><div class="lbl">Replied</div><div class="v num">{data.totals.replies}</div><div class="s">{pct(data.totals.replies, contacted)} of contacted</div></div>
  <div class="kpi" class:warn={data.totals.sent && data.totals.bounces / data.totals.sent >= 0.05}><div class="lbl">Bounced</div><div class="v num">{data.totals.bounces}</div><div class="s">{pct(data.totals.bounces, data.totals.sent)} · alarm at 5%</div></div>
  <div class="kpi hot"><div class="lbl">Interested</div><div class="v num">{opps}</div><div class="s">{data.counts.interested} interested · {data.counts.meeting} meeting · {data.counts.won} won</div></div>
</div>
<div class="panel">
  <div class="hd"><h3>Per day</h3><div class="acts">
    <a class="btn sm" class:ghost={data.days !== 0} href="?days=0">Since start</a>
    <a class="btn sm" class:ghost={data.days !== 7} href="?days=7">7 days</a>
    <a class="btn sm" class:ghost={data.days !== 28} href="?days=28">28 days</a>
  </div></div>
  <Chart points={data.points} />
</div>
<div class="grid2" style="margin-top:18px">
  <div class="panel">
    <div class="hd"><h3>By step</h3></div>
    <div class="wrap"><table style="min-width:0">
      <thead><tr><th>Step</th><th class="rt">Sent</th><th class="rt">Opened</th><th class="rt">Replied</th><th class="rt">Bounced</th></tr></thead>
      <tbody>
        {#each data.campaign.steps as step, i}
          {@const s = data.byStep.find((r: any) => r.key === i)}
          <tr><td>{i + 1} · {step.subject || 'same thread'}{#if i > 0} · +{step.delayDays} d{/if}</td><td class="rt num">{s?.sent ?? 0}</td><td class="rt num">{s?.uniqueOpens ?? 0} · {pctInt(s?.uniqueOpens ?? 0, s?.sent ?? 0)}</td><td class="rt num">{s?.replies ?? 0} · {pct(s?.replies ?? 0, s?.sent ?? 0)}</td><td class="rt num">{s?.bounces ?? 0}</td></tr>
        {/each}
      </tbody></table></div>
  </div>
  <div class="panel">
    <div class="hd"><h3>By mailbox</h3></div>
    <div class="wrap"><table style="min-width:0">
      <thead><tr><th>Mailbox</th><th class="rt">Today</th><th class="rt">Sent</th><th class="rt">Replied</th><th class="rt">Bounce</th></tr></thead>
      <tbody>
        {#each data.byAccount as a}
          <tr><td>{a.address} {#if a.status !== 'active'}<span class="tag bad">{a.status}</span>{/if}</td><td class="rt num">{a.sentToday} / {a.limit}</td><td class="rt num">{a.sent}</td><td class="rt num">{a.replies}</td><td class="rt num">{pct(a.bounces, a.sent)}</td></tr>
        {:else}
          <tr><td colspan="5" class="mute">No mailbox assigned. Pick one in Options.</td></tr>
        {/each}
      </tbody></table></div>
  </div>
</div>
