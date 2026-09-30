<script lang="ts">
  let { value = $bindable(''), name = 'body', placeholder = 'Write the email…' }: { value?: string; name?: string; placeholder?: string } = $props();
  let el: HTMLDivElement | undefined = $state();
  let showLink = $state(false);
  let linkUrl = $state('https://');
  let savedRange: Range | null = null;

  $effect(() => { if (el && el.innerHTML !== value) el.innerHTML = value; });

  function saveSel() { const s = window.getSelection(); if (s && s.rangeCount && el?.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange(); }
  function restoreSel() { const s = window.getSelection(); if (savedRange && s) { s.removeAllRanges(); s.addRange(savedRange); } }
  function sync() { if (el) value = el.innerHTML; }
  function cmd(c: string, arg?: string) { el?.focus(); restoreSel(); document.execCommand(c, false, arg); sync(); saveSel(); }
  function onPaste(e: ClipboardEvent) { e.preventDefault(); const t = e.clipboardData?.getData('text/plain') ?? ''; document.execCommand('insertText', false, t); sync(); }
  export function insertText(t: string) { el?.focus(); restoreSel(); document.execCommand('insertText', false, t); sync(); saveSel(); }
  function applyLink() {
    const url = linkUrl.trim();
    showLink = false;
    if (!url || url === 'https://') return;
    el?.focus(); restoreSel();
    const s = window.getSelection();
    if (!s || s.isCollapsed) document.execCommand('insertHTML', false, `<a href="${url.replace(/"/g, '')}">${url}</a>`);
    else document.execCommand('createLink', false, url);
    sync();
  }
</script>

<div class="rte">
  <div class="rte-bar" role="toolbar" aria-label="Formatting">
    <button type="button" title="Bold" onmousedown={(e) => e.preventDefault()} onclick={() => cmd('bold')}><b>B</b></button>
    <button type="button" title="Italic" onmousedown={(e) => e.preventDefault()} onclick={() => cmd('italic')}><i>I</i></button>
    <button type="button" title="Underline" onmousedown={(e) => e.preventDefault()} onclick={() => cmd('underline')}><u>U</u></button>
    <span class="sep"></span>
    <button type="button" title="Link" onmousedown={(e) => e.preventDefault()} onclick={() => { saveSel(); showLink = !showLink; }}>link</button>
    <button type="button" title="Bulleted list" onmousedown={(e) => e.preventDefault()} onclick={() => cmd('insertUnorderedList')}>• list</button>
    <button type="button" title="Numbered list" onmousedown={(e) => e.preventDefault()} onclick={() => cmd('insertOrderedList')}>1. list</button>
    <span class="sep"></span>
    <button type="button" title="Remove formatting" onmousedown={(e) => e.preventDefault()} onclick={() => { cmd('removeFormat'); cmd('unlink'); }}>clear</button>
    {#if showLink}
      <span class="rte-link">
        <input class="in" bind:value={linkUrl} placeholder="https://…" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink(); } if (e.key === 'Escape') showLink = false; }} />
        <button type="button" class="btn sm" onclick={applyLink}>Apply</button>
      </span>
    {/if}
  </div>
  <div class="rte-body in" contenteditable="true" bind:this={el} oninput={sync} onpaste={onPaste} onkeyup={saveSel} onmouseup={saveSel} onblur={saveSel} data-placeholder={placeholder} role="textbox" aria-multiline="true" tabindex="0"></div>
  <input type="hidden" {name} {value} />
</div>

<style>
  .rte { display: flex; flex-direction: column; gap: 0; }
  .rte-bar { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; border: 2px solid var(--line); border-bottom: 0; background: var(--ink); padding: 6px 8px; }
  .rte-bar button { background: none; border: 1px solid transparent; color: var(--mute); font: 12px var(--mono); padding: 3px 8px; cursor: pointer; }
  .rte-bar button:hover { border-color: var(--line); color: var(--bone); }
  .rte-bar .sep { width: 1px; height: 16px; background: var(--line); margin: 0 4px; }
  .rte-link { display: inline-flex; gap: 6px; align-items: center; margin-left: 8px; }
  .rte-link .in { width: 260px; padding: 4px 8px; font-size: 12px; }
  .rte-body { min-height: 300px; font-family: var(--sans); font-size: 14px; line-height: 1.55; outline: none; white-space: pre-wrap; word-break: break-word; }
  .rte-body:empty::before { content: attr(data-placeholder); color: var(--mute); opacity: .7; }
  .rte-body :global(a) { color: var(--hot); }
  .rte-body :global(p), .rte-body :global(div) { margin: 0 0 .9em; }
  .rte-body :global(ul), .rte-body :global(ol) { margin: 0 0 .9em 1.2em; }
</style>
