<script lang="ts">
  import { enhance } from '$app/forms';
  let { data, form } = $props();
  let step = $state(1);
  let preset = $state('titan');
  let detectedNote = $state('');
  let busy = $state('');
  const v = $derived(form?.values ?? {});
  let imapHost = $state(''), imapPort = $state(993), imapSecure = $state(true), smtpHost = $state(''), smtpPort = $state(587), smtpSecure = $state(false);
  function applyPreset(k: string) { preset = k; const p = data.presets[k]; imapHost = p.imap.host; imapPort = p.imap.port; imapSecure = p.imap.secure; smtpHost = p.smtp.host; smtpPort = p.smtp.port; smtpSecure = p.smtp.secure; }
  $effect(() => {
    if (form?.detected) {
      const d = form.detected;
      if (d.preset === 'microsoft') { detectedNote = `${d.domain} is on Microsoft 365 (${d.mx}). Microsoft does not accept passwords over IMAP since 2022: use “Connect with Microsoft” on the Emails screen for this one.`; }
      else { applyPreset(d.preset); detectedNote = `${d.domain} is on ${d.provider} (${d.mx || 'no MX record'}). Servers filled in; type the mailbox password and test.`; step = 2; }
    } else if (v.imapHost) { imapHost = v.imapHost; imapPort = Number(v.imapPort); imapSecure = v.imapSecure === 'on'; smtpHost = v.smtpHost; smtpPort = Number(v.smtpPort); smtpSecure = v.smtpSecure === 'on'; step = 2; }
    else if (!imapHost) applyPreset('titan');
  });
</script>
<svelte:head><title>Connect a mailbox · Hedwig</title></svelte:head>
<div class="top"><div><div class="lbl"><a href="/emails">← emails</a></div><h1 class="disp" style="margin-top:6px">Connect a mailbox</h1><div class="sub">any provider with IMAP and SMTP · the only exception is Microsoft 365, which needs its consent button</div></div></div>
<form class="panel" method="POST" use:enhance={({ action }) => { busy = action.search.replace('?/', ''); return async ({ update }) => { busy = ''; await update({ reset: false }); }; }} style="max-width:980px">
  <div class="steps"><button type="button" class:on={step === 1} onclick={() => (step = 1)}><b>01</b>Identity</button><button type="button" class:on={step === 2} onclick={() => (step = 2)}><b>02</b>Servers &amp; test</button></div>
  <div class="bd" style:display={step === 1 ? '' : 'none'}>
    <div class="frow">
      <label class="field"><span class="lbl">From name</span><input class="in" name="fromName" value={v.fromName ?? ''} placeholder="The name recipients see" /></label>
      <label class="field"><span class="lbl">Email address</span><input class="in" name="address" type="email" value={v.address ?? ''} placeholder="name@yourdomain.com" required /><span class="help">works with any provider that has IMAP and SMTP: Titan, Zoho, Google, IONOS, Hostinger, your own server</span></label>
      <label class="field"><span class="lbl">Daily limit</span><input class="in num" name="dailyLimit" type="number" min="1" max="500" value={v.dailyLimit ?? 30} /><span class="help">30–40 is the safe zone for cold email</span></label>
      <label class="field"><span class="lbl">New mailbox?</span><label class="chip" style="cursor:pointer"><input type="checkbox" name="ramp" checked={v.ramp ? v.ramp === 'on' : true} /> ramp: 10 a day, +5 a week</label><span class="help">untick if this mailbox has months of real sending behind it</span></label>
    </div>
    {#if detectedNote}<div class="note blue" style="margin-top:14px">{detectedNote}</div>{/if}
    {#if form?.error && step === 1}<div class="flash err" style="margin-top:14px">{form.error}</div>{/if}
    <div class="acts" style="margin-top:16px"><button class="btn pri" type="submit" formaction="?/detect" formnovalidate disabled={busy === 'detect'}>{busy === 'detect' ? 'Looking up the domain…' : 'Detect the servers from the address →'}</button><button class="btn" type="button" onclick={() => (step = 2)}>Fill them in myself →</button></div>
  </div>
  <div class="bd stack" style:display={step === 2 ? '' : 'none'}>
    <div class="presets">
      <span class="lbl" style="align-self:center">preset</span>
      {#each Object.entries(data.presets) as [k, p]}<button type="button" class="btn sm" class:pri={preset === k} onclick={() => applyPreset(k)}>{p.label}</button>{/each}
    </div>
    <div class="note">{data.presets[preset]?.note} Microsoft 365 mailboxes cannot use this form: Microsoft ended password logins for IMAP in 2022. Use “Connect with Microsoft”.</div>
    <div class="grid2">
      <div class="stack">
        <div class="lbl">IMAP · reads replies</div>
        <div class="frow"><label class="field"><span class="lbl">Host</span><input class="in" name="imapHost" bind:value={imapHost} required /></label><label class="field"><span class="lbl">Port</span><input class="in num" name="imapPort" type="number" bind:value={imapPort} /></label></div>
        <div class="frow"><label class="field"><span class="lbl">User</span><input class="in" name="imapUser" value={v.imapUser ?? ''} placeholder="usually the email address" /></label><label class="field"><span class="lbl">Password / app password</span><input class="in" name="imapPass" type="password" autocomplete="off" required /></label></div>
        <label class="chip" style="cursor:pointer;align-self:flex-start"><input type="checkbox" name="imapSecure" bind:checked={imapSecure} /> TLS (port 993)</label>
      </div>
      <div class="stack">
        <div class="lbl">SMTP · sends</div>
        <div class="frow"><label class="field"><span class="lbl">Host</span><input class="in" name="smtpHost" bind:value={smtpHost} required /></label><label class="field"><span class="lbl">Port</span><input class="in num" name="smtpPort" type="number" bind:value={smtpPort} /></label></div>
        <div class="frow"><label class="field"><span class="lbl">User</span><input class="in" name="smtpUser" value={v.smtpUser ?? ''} placeholder="usually the email address" /></label><label class="field"><span class="lbl">Password</span><input class="in" name="smtpPass" type="password" autocomplete="off" placeholder="same as IMAP if empty" /></label></div>
        <label class="chip" style="cursor:pointer;align-self:flex-start"><input type="checkbox" name="smtpSecure" bind:checked={smtpSecure} /> TLS from the first byte (port 465) · off = STARTTLS (port 587)</label>
        <span class="help">587 with STARTTLS is the default: many cloud servers, this one included, block outgoing port 465. If the port and this box disagree, the port wins.</span>
      </div>
    </div>
    {#if form?.testOk}<div class="test"><span class="ok">✓</span><span>{form.testOk}</span></div>{/if}
    {#if form?.error}<div class="flash err">{form.error}</div>{/if}
    <div class="note"><b>Passwords are encrypted at rest</b> with a key that lives only on the server. They are typed here, never shared in chat. Google needs 2-step verification and an app password.</div>
    <div class="acts">
      <button class="btn" type="button" onclick={() => (step = 1)}>← Back</button>
      <button class="btn" type="submit" formaction="?/test" disabled={!!busy}>{busy === 'test' ? 'Testing IMAP and SMTP…' : 'Test both'}</button>
      <button class="btn pri" type="submit" formaction="?/save" disabled={!!busy}>{busy === 'save' ? 'Testing and connecting…' : 'Test and connect'}</button>
    </div>
  </div>
</form>
