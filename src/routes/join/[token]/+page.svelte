<script lang="ts">
  import { enhance } from '$app/forms';
  import Owl from '$lib/ui/Owl.svelte';
  let { data, form } = $props();
</script>
<svelte:head><title>Join a team · Hedwig</title></svelte:head>
<div class="auth">
  <div class="card">
    <Owl size={92} />
    {#if !data.valid}
      <h1 class="disp">Link not valid</h1>
      <p>{data.reason}</p>
      <p><a href="/login">Log in</a></p>
    {:else}
      <h1 class="disp">Join {data.org}</h1>
      <p>{data.inviter} invited <b>{data.email}</b> to the team {data.org} on Hedwig.</p>
      {#if form?.error}<div class="flash err">{form.error}</div>{/if}
      {#if data.signedInAs && !data.sameUser}
        <p>You are signed in as <b>{data.signedInAs}</b>. This invitation is for {data.email}: sign out, then open the link again.</p>
        <form method="POST" action="/logout"><button class="btn" type="submit">Sign out</button></form>
      {:else if data.sameUser}
        {#if data.alreadyIn}
          <p>You are already in {data.org}.</p>
          <form method="POST" action="?/accept" use:enhance><button class="btn pri" type="submit">Go to {data.org}</button></form>
        {:else}
          <form method="POST" action="?/accept" use:enhance><button class="btn pri" type="submit">Join {data.org}</button></form>
        {/if}
      {:else if data.hasAccount}
        <form class="stack" method="POST" action="?/login" use:enhance>
          <label class="field"><span class="lbl">Email</span><input class="in" type="email" value={data.email} autocomplete="username" readonly /></label>
          <label class="field"><span class="lbl">Password</span><input class="in" name="password" type="password" autocomplete="current-password" required /></label>
          <button class="btn pri" type="submit">Log in and join</button>
        </form>
      {:else}
        <form class="stack" method="POST" action="?/signup" use:enhance>
          <label class="field"><span class="lbl">Email</span><input class="in" type="email" value={data.email} autocomplete="username" readonly /></label>
          <label class="field"><span class="lbl">Name</span><input class="in" name="name" autocomplete="name" value={form?.name ?? ''} /></label>
          <label class="field"><span class="lbl">Password</span><input class="in" name="password" type="password" autocomplete="new-password" minlength="6" required /><span class="help">at least 6 characters</span></label>
          <button class="btn pri" type="submit">Create account and join</button>
        </form>
      {/if}
      <p class="mute" style="font-size:12px">Only {data.email} can use this link, once. Your own Personal space stays yours; the team sees only what is in {data.org}.</p>
    {/if}
  </div>
</div>
