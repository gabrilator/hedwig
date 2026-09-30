// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import TimezoneSelect from '../../src/lib/ui/TimezoneSelect.svelte';
import { timezoneOptions } from '../../src/lib/server/timezones';
// Use the DOM runtime for this component test in the server-oriented app config.
vi.mock('svelte', async () => {
  // @ts-expect-error Svelte's internal client entry has no public declaration file.
  return import('../../node_modules/svelte/src/index-client.js');
});

it('keeps its zone when the form is reset after a save, instead of jumping to UTC−12', async () => {
  // a select rendered in the browser (a panel opened on click) has no `selected` attribute from the server
  const form = document.createElement('form');
  document.body.append(form);
  const component = mount(TimezoneSelect, { target: form, props: { zones: timezoneOptions(), value: 'America/Toronto', required: false } });
  flushSync();
  try {
    const select = form.querySelector('select')!;
    expect(select.value).toBe('America/Toronto');
    form.reset(); // what use:enhance does after a successful action
    await Promise.resolve(); await Promise.resolve();
    flushSync();
    expect(select.value).toBe('America/Toronto');
    expect(new FormData(form).get('timezone')).toBe('America/Toronto');
  } finally {
    await unmount(component); form.remove();
  }
});
