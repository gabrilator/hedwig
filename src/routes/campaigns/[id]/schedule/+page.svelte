<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { fmtTime } from '$lib/ui/format';
  import TimezoneSelect from '$lib/ui/TimezoneSelect.svelte';
  import { toast } from '$lib/ui/motion.svelte';
  let { data, form } = $props();
  const s = $derived(data.campaign.schedule);
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  let days = $state<number[]>([]);
  $effect(() => { days = [...s.days]; });
  const tz = $derived(s.timezone);
  const gapMin = $derived.by(() => { const [fh, fm] = s.from.split(':').map(Number); const [th, tm] = s.to.split(':').map(Number); const mins = th * 60 + tm - (fh * 60 + fm); return mins > 0 ? Math.round((mins / Math.max(1, data.campaign.dailyLimit)) * 10) / 10 : 0; });
  const sentCount = $derived(data.plan.filter((p: any) => p.status === 'sent').length);
  const plannedCount = $derived(data.plan.filter((p: any) => p.status === 'planned' || p.status === 'claimed').length);
  $effect(() => { if (form?.saved) { toast('Schedule saved'); invalidateAll(); } });
  // strip geometry
  const toMin = (iso: string) => { const d = new Date(iso); const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).formatToParts(d); const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0), m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0); return h * 60 + m; };
  const winFrom = $derived(Number(s.from.slice(0, 2)) * 60 + Number(s.from.slice(3)));
  const winTo = $derived(Number(s.to.slice(0, 2)) * 60 + Number(s.to.slice(3)));
  const xOf = (min: number, W: number) => 1 + ((min - winFrom) / Math.max(1, winTo - winFrom)) * (W - 2);
  const nowMin = $derived(toMin(new Date(data.now).toISOString()));
  const W = 700;
</script>
<div class="grid2">
  <div class="stack">
    <form class="panel" method="POST" action="?/save" use:enhance>
      <div class="hd"><h3>Window</h3><span class="lbl">{data.window ? (data.window.open ? 'open now' : `closed · ${data.window.reason}`) : data.tzError}</span></div>
      <div class="bd stack">
        <div class="frow">
          <label class="field"><span class="lbl">From</span><input class="in" name="from" type="time" value={s.from} required /></label>
          <label class="field"><span class="lbl">To</span><input class="in" name="to" type="time" value={s.to} required /></label>
          <label class="field"><span class="lbl">Timezone</span><TimezoneSelect zones={data.timezones} value={s.timezone} /><span class="help">The window is read in this zone. The worker adapts on its own.</span></label>
        </div>
        <div class="field"><span class="lbl">Days</span><div class="tg" role="group">{#each order as d}<input type="checkbox" name="days" value={d} bind:group={days} style="display:none" /><button type="button" class:on={days.includes(d)} onclick={() => { days = days.includes(d) ? days.filter((x) => x !== d) : [...days, d]; }}>{DAYS[d]}</button>{/each}</div></div>
        <div class="frow">
          <label class="field"><span class="lbl">Start</span><input class="in" name="startAt" type="date" value={s.startAt ? String(s.startAt).slice(0, 10) : ''} /><span class="help">empty = now</span></label>
          <label class="field"><span class="lbl">End</span><input class="in" name="endAt" type="date" value={s.endAt ? String(s.endAt).slice(0, 10) : ''} /><span class="help">empty = no end</span></label>
          <label class="field"><span class="lbl">Daily limit for this campaign</span><input class="in num" name="dailyLimit" type="number" min="1" value={data.campaign.dailyLimit} /><span class="help">each mailbox also has its own limit</span></label>
        </div>
        {#if form?.error}<div class="flash err">{form.error}</div>{/if}
        <div class="acts"><button class="btn pri" type="submit">Save schedule</button></div>
      </div>
    </form>
    <div class="panel">
      <div class="hd"><h3>Pace</h3></div>
      <div class="bd stack">
        <div class="note blue"><b>Spread, never a burst.</b> {data.campaign.dailyLimit} a day between {s.from} and {s.to} is one email every ~{gapMin} minutes, each moved by up to ±40%. Follow-ups already due take the first slots.</div>
        <div class="note"><b>Closed days.</b> A follow-up that falls on a closed day goes out at the next open window{#if data.next} (next: {new Date(data.next).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz })} {tz}){/if}.</div>
      </div>
    </div>
  </div>
  <div class="panel">
    <div class="hd"><h3>Today's plan</h3><span class="lbl">{data.window?.localDay ?? ''} · {tz}</span></div>
    <div class="spread">
      <svg viewBox="0 0 {W} 56" role="img" aria-label="Planned send times for today">
        <rect x="1" y="18" width={W - 2} height="14" fill="none" stroke="var(--bone)" stroke-width="2" />
        {#each Array.from({ length: Math.floor((winTo - winFrom) / 60) + 1 }, (_, i) => winFrom + i * 60) as m}
          {#if m <= winTo}<text class="ax" x={xOf(m, W)} y="50" text-anchor={m === winFrom ? 'start' : m >= winTo - 30 ? 'end' : 'middle'}>{String(Math.floor(m / 60)).padStart(2, '0')}:{String(m % 60).padStart(2, '0')}</text>{/if}
        {/each}
        {#each data.plan as p}
          {@const m = toMin(p.dueAt)}
          {#if m >= winFrom && m <= winTo}<rect x={xOf(m, W) - 1} y={p.status === 'sent' ? 20 : 22} width="2" height={p.status === 'sent' ? 10 : 6} fill={p.status === 'sent' ? 'var(--blue)' : p.status === 'cancelled' ? 'var(--red)' : 'var(--mute)'} />{/if}
        {/each}
        {#if nowMin >= winFrom && nowMin <= winTo}
          <line x1={xOf(nowMin, W)} x2={xOf(nowMin, W)} y1="8" y2="38" stroke="var(--red)" stroke-width="2" />
          <text class="ax" x={xOf(nowMin, W) + 6} y="12" style="fill:var(--red)">now · {sentCount} sent</text>
        {/if}
      </svg>
    </div>
    <div class="bd stack">
      <div class="note"><b>{sentCount} sent, {plannedCount} planned.</b> Each tick is one email. Blue ticks went out; grey ticks are booked for later today. A reply removes that lead's future ticks.{#if data.campaign.status !== 'active'} The campaign is {data.campaign.status}, so nothing is booked.{/if}</div>
      {#if data.plan.length}
        <div class="wrap"><table style="min-width:0"><thead><tr><th>Time</th><th>Lead</th><th>Step</th><th>Mailbox</th><th>State</th></tr></thead><tbody>
          {#each data.plan.slice(0, 60) as p}<tr><td class="num">{fmtTime(p.dueAt, tz)}</td><td>{p.lead}</td><td>{p.stepIndex + 1}</td><td>{p.account}</td><td class="mute">{p.status}</td></tr>{/each}
          {#if data.plan.length > 60}<tr><td colspan="5" class="mute">{data.plan.length - 60} more</td></tr>{/if}
        </tbody></table></div>
      {/if}
    </div>
  </div>
</div>
