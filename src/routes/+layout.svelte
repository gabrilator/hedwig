<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import Owl from '$lib/ui/Owl.svelte';
  import Flight from '$lib/ui/Flight.svelte';
  import { fly } from '$lib/ui/motion.svelte';
  import { readTheme, theme, toggleTheme } from '$lib/ui/theme.svelte';

  let { children, data } = $props();
  const nav = [
    { href: '/campaigns', label: 'Campaigns', k: '1' },
    { href: '/inbox', label: 'Inbox', k: '2' },
    { href: '/analytics', label: 'Analytics', k: '3' },
    { href: '/emails', label: 'Emails', k: '4' },
    { href: '/agents', label: 'Agents', k: '5' },
    { href: '/team', label: 'Team', k: '6' },
    { href: '/lists', label: 'Lists', k: '7' }
  ];
  const active = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(href + '/');

  onMount(() => {
    readTheme();
    if (data.user && !sessionStorage.getItem('hedwig-flew')) { setTimeout(() => fly(), 700); sessionStorage.setItem('hedwig-flew', '1'); }
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.matches?.('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = nav.find((x) => x.k === e.key);
      if (hit && data.user) goto(hit.href);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<svelte:head><title>Hedwig</title></svelte:head>

{#if data.user}
  <div class="app">
    <aside class="side">
      <button class="logo" type="button" onclick={() => { fly(); goto('/campaigns'); }} title="Click her, she flies">
        <Owl size={44} />
        <span class="word disp">Hedwig</span>
      </button>
      <nav class="nav">
        {#each nav as item}
          <a href={item.href} class:on={active(item.href)}><span>{item.label}{#if item.href === '/inbox' && data.inboxUnread} <span class="badge">{data.inboxUnread}</span>{/if}</span><span class="k">{item.k}</span></a>
        {/each}
      </nav>
      <div class="foot">
        <form method="POST" action="/team?/switch">
          <label class="lbl" for="space-select">space</label>
          <select id="space-select" class="in" name="space" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
            {#each data.spaces ?? [] as s}<option value={s.key} selected={s.key === data.space?.key}>{s.name}</option>{/each}
          </select>
        </form>
        <div class="who">
          {data.user.email}<br>
          <a href="/setup" class:y={page.url.pathname === '/setup'}>setup</a> · {#if theme.known}<button class="linkbtn" type="button" onclick={toggleTheme}>{theme.light ? 'dark' : 'light'}</button>{' · '}{/if}<form method="POST" action="/logout"><button class="linkbtn" type="submit">sign out</button></form>
        </div>
      </div>
    </aside>
    <main class="main">
      <div class="mtop">
        <button class="logo" type="button" onclick={() => { fly(); goto('/campaigns'); }}><Owl size={30} /><span class="word disp">Hedwig</span></button>
        <span class="mtop-r">{#if theme.known}<button class="linkbtn mute" type="button" onclick={toggleTheme}>{theme.light ? 'dark' : 'light'}</button>{/if}<a class="orgsw" href="/team">{data.space?.name} ▾</a></span>
      </div>
      {@render children()}
    </main>
    <nav class="bottom">
      {#each nav as item}<a href={item.href} class:on={active(item.href)}>{item.label}{#if item.href === '/inbox' && data.inboxUnread} <span class="badge">{data.inboxUnread}</span>{/if}</a>{/each}
    </nav>
  </div>
{:else}
  {@render children()}
{/if}
<Flight />
