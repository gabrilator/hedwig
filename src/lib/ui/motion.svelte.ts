import { untrack } from 'svelte';

/** Hedwig's flight and the toast. fly('message') makes her cross the screen and then shows the message. */
export const motion = $state({ flying: false, toast: '' as string, toastKind: 'ok' as 'ok' | 'err', flightKey: 0 });
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, kind: 'ok' | 'err' = 'ok', ms = 3400) {
  untrack(() => { motion.toast = message; motion.toastKind = kind; });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { motion.toast = ''; }, ms);
}
let flights = 0;
/**
 * Safe to call from inside a $effect: it never reads reactive state (the flight counter is a plain variable), so an
 * effect that triggers a flight does not depend on the flight and cannot re-run itself into a loop.
 */
export function fly(message?: string, kind: 'ok' | 'err' = 'ok') {
  const still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!still) untrack(() => { motion.flying = false; motion.flightKey = ++flights; motion.flying = true; });
  if (message) setTimeout(() => toast(message, kind), still ? 0 : 2400);
}
