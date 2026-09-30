// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ConfirmDelete from '../../src/lib/ui/ConfirmDelete.svelte';
// Use the DOM runtime for this component test in the server-oriented app config.
vi.mock('svelte', async () => {
  // @ts-expect-error Svelte's internal client entry has no public declaration file.
  return import('../../node_modules/svelte/src/index-client.js');
});

it('confirms deletion without native confirm and supports Cancel and Escape', async () => {
  const nativeConfirm = vi.fn(() => false);
  vi.stubGlobal('confirm', nativeConfirm);
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(ConfirmDelete, { target });
  flushSync();
  try {
    const dialog = target.querySelector('dialog')!;
    const buttons = target.querySelectorAll('button');
    const cancelled = component.ask('Remove these 6 threads?');
    flushSync();
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('Remove these 6 threads?');
    buttons[0].click();
    await expect(cancelled).resolves.toBe(false);
    expect(dialog.open).toBe(false);
    const confirmed = component.ask('Remove this thread?');
    buttons[1].click();
    await expect(confirmed).resolves.toBe(true);
    const escaped = component.ask('Remove this message?');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await expect(escaped).resolves.toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
  } finally {
    await unmount(component); target.remove(); vi.unstubAllGlobals();
  }
});
