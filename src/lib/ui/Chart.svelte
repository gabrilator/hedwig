<script lang="ts">
  import type { SeriesPoint } from '$lib/server/stats';
  let { points, label = 'Per day' }: { points: SeriesPoint[]; label?: string } = $props();

  let host: HTMLDivElement;
  let width = $state(700);
  let hover = $state<number | null>(null);
  const H = 240, padL = 34, padT = 14, padB = 26;
  const narrow = $derived(width < 520);
  const padR = $derived(narrow ? 14 : 96);
  const n = $derived(points.length);
  const iw = $derived(width - padL - padR);
  const ih = H - padT - padB;
  const max = $derived(Math.max(10, Math.ceil(Math.max(...points.map((p) => Math.max(p.sent, p.uniqueOpens, p.replies)), 1) / 10) * 10));
  const ticks = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f)));
  const x = (i: number) => padL + (n > 1 ? i * (iw / (n - 1)) : iw / 2);
  const y = (v: number) => padT + ih - (v / max) * ih;
  const path = (key: 'sent' | 'uniqueOpens' | 'replies') => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const series = [
    { key: 'sent' as const, name: 'Sent', col: 'var(--s-sent)' },
    { key: 'uniqueOpens' as const, name: 'Opens', col: 'var(--s-open)' },
    { key: 'replies' as const, name: 'Replies', col: 'var(--s-reply)' }
  ];
  const labelEvery = $derived(n > 120 ? (narrow ? 45 : 30) : n > 60 ? (narrow ? 21 : 14) : n > 14 ? (narrow ? 7 : 4) : narrow ? 3 : 2);
  const shortDay = (d: string) => { const dt = new Date(d + 'T12:00:00Z'); return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); };
  const fullDay = (d: string) => { const dt = new Date(d + 'T12:00:00Z'); return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };
  const ends = $derived.by(() => {
    const e = series.map((s) => ({ ...s, v: points[n - 1]?.[s.key] ?? 0, yy: y(points[n - 1]?.[s.key] ?? 0) })).sort((a, b) => a.yy - b.yy);
    for (let i = 1; i < e.length; i++) if (e[i].yy - e[i - 1].yy < 14) e[i].yy = e[i - 1].yy + 14;
    return e;
  });
  $effect(() => {
    const ro = new ResizeObserver(() => { width = Math.max(120, host.clientWidth - 20); });
    ro.observe(host);
    width = Math.max(120, host.clientWidth - 20);
    return () => ro.disconnect();
  });
  function onMove(e: MouseEvent | TouchEvent) {
    const svg = host.querySelector('svg')!;
    const r = svg.getBoundingClientRect();
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const mx = cx - r.left;
    let i = n > 1 ? Math.round((mx - padL) / (iw / (n - 1))) : 0;
    hover = Math.max(0, Math.min(n - 1, i));
  }
</script>

<div class="chart" bind:this={host} onmousemove={onMove} ontouchstart={onMove} ontouchmove={onMove} onmouseleave={() => (hover = null)} role="img" aria-label={label}>
  <svg viewBox="0 0 {width} {H}" width={width} height={H}>
    {#each ticks as t}
      <line class="g" x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
      <text class="ax" x={padL - 8} y={y(t) + 4} text-anchor="end">{t}</text>
    {/each}
    {#each points as p, i}
      {#if (i % labelEvery === 0 && n - 1 - i >= labelEvery * 0.6) || i === n - 1}
        <text class="ax" x={x(i)} y={H - 6} text-anchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{shortDay(p.day)}</text>
      {/if}
    {/each}
    {#if n > 1}
      <path d="{path('sent')} L{x(n - 1)},{y(0)} L{x(0)},{y(0)} Z" fill="var(--s-sent)" opacity=".10" />
    {/if}
    {#each series as s}
      <path d={path(s.key)} fill="none" stroke={s.col} stroke-width="2" stroke-linejoin="miter" />
      {#each points as p, i}
        {#if n <= 14 || i === n - 1}
          <rect x={x(i) - 3} y={y(p[s.key]) - 3} width="6" height="6" fill={s.col} stroke="var(--panel)" stroke-width="2" />
        {/if}
      {/each}
    {/each}
    {#if !narrow}
      {#each ends as e}
        <rect x={width - padR + 10} y={e.yy - 4} width="8" height="8" fill={e.col} />
        <text class="dl" x={width - padR + 24} y={e.yy + 4}>{e.name} {e.v}</text>
      {/each}
    {/if}
    {#if hover !== null}
      <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} stroke="var(--bone)" stroke-dasharray="3 3" />
    {/if}
  </svg>
  {#if hover !== null && points[hover]}
    <div class="tip" style:left="{Math.max(0, x(hover) + 14 + 160 > width ? x(hover) - 170 : x(hover) + 14)}px" style:top="{padT + 6}px">
      <b>{fullDay(points[hover].day)}</b>
      {#each series as s}
        <div><span><i style:background={s.col}></i>{s.name}</span><span>{points[hover][s.key]}</span></div>
      {/each}
      <div><span><i style:background="var(--s-bounce)"></i>Bounces</span><span>{points[hover].bounces}</span></div>
    </div>
  {/if}
</div>
<div class="legend">
  {#each series as s}<span><i style:background={s.col}></i>{s.name}</span>{/each}
</div>
