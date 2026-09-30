import { describe, expect, it } from 'vitest';
import { nextOpen, spreadSlots, windowFor } from '../../src/lib/server/planner';
import { effectiveDailyLimit, selfPauseReason } from '../../src/lib/server/accounts';

const lisbon = { timezone: 'Europe/Lisbon', from: '09:00', to: '15:00', days: [1, 2, 3, 4, 5] };

describe('windowFor', () => {
  it('is open inside the window on a weekday, in the schedule zone', () => {
    // Thu 2026-09-03 11:00 Lisbon (UTC+1) = 10:00Z
    const w = windowFor(lisbon, new Date('2026-09-03T10:00:00Z'));
    expect(w.open).toBe(true);
    expect(w.start.toISOString()).toBe('2026-09-03T08:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-03T14:00:00.000Z');
  });
  it('is closed on Saturday and before the window', () => {
    expect(windowFor(lisbon, new Date('2026-09-05T10:00:00Z')).reason).toBe('closed day');
    expect(windowFor(lisbon, new Date('2026-09-03T07:30:00Z')).reason).toBe('before the window');
  });
  it('adapts to another timezone transparently', () => {
    const toronto = { ...lisbon, timezone: 'America/Toronto' };
    // 10:00Z is 06:00 in Toronto (EDT) → before the window
    expect(windowFor(toronto, new Date('2026-09-03T10:00:00Z')).open).toBe(false);
    expect(windowFor(toronto, new Date('2026-09-03T14:30:00Z')).open).toBe(true);
  });
  it('rejects a bad timezone', () => { expect(() => windowFor({ ...lisbon, timezone: 'Mars/Olympus' }, new Date())).toThrow(/timezone/); });
});
describe('nextOpen', () => {
  it('moves a Saturday to Monday 09:00 local', () => {
    const n = nextOpen(lisbon, new Date('2026-09-05T10:00:00Z'))!;
    expect(n.toISOString()).toBe('2026-09-07T08:00:00.000Z');
  });
});
describe('spreadSlots', () => {
  it('spreads n slots inside the window, sorted, with a real gap', () => {
    let seed = 3; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const from = new Date('2026-09-03T08:00:00Z'), to = new Date('2026-09-03T14:00:00Z');
    const slots = spreadSlots(from, to, 40, rnd);
    expect(slots).toHaveLength(40);
    for (const s of slots) { expect(s >= from).toBe(true); expect(s < to).toBe(true); }
    for (let i = 1; i < slots.length; i++) expect(slots[i] >= slots[i - 1]).toBe(true);
    const gaps = slots.slice(1).map((s, i) => s.getTime() - slots[i].getTime());
    expect(Math.max(...gaps)).toBeLessThan(2 * 9 * 60_000);
    expect(slots[0].getTime() - from.getTime()).toBeLessThan(20 * 60_000);
  });
});
describe('effectiveDailyLimit', () => {
  it('ramps 10, +5 a week, capped at the limit', () => {
    const start = new Date('2026-09-01T00:00:00Z');
    const acc = { dailyLimit: 40, ramp: { enabled: true, startedAt: start } };
    expect(effectiveDailyLimit(acc, new Date('2026-09-02T00:00:00Z'))).toBe(10);
    expect(effectiveDailyLimit(acc, new Date('2026-09-15T00:00:00Z'))).toBe(20);
    expect(effectiveDailyLimit(acc, new Date('2026-12-01T00:00:00Z'))).toBe(40);
    expect(effectiveDailyLimit({ ...acc, ramp: { enabled: false, startedAt: start } }, new Date())).toBe(40);
  });
});

describe('selfPauseReason', () => {
  it('needs 20 sends and 2 bounces, then the mailbox\'s percentage (5 by default, 0 = never)', () => {
    expect(selfPauseReason({}, 30, 1)).toBeNull();          // one bounce is never a pattern
    expect(selfPauseReason({}, 19, 5)).toBeNull();          // not enough volume to judge
    expect(selfPauseReason({}, 40, 2)).toMatch(/2 bounces on 40 sends in the last 7 days \(5%, the limit is 5%\)/);
    expect(selfPauseReason({}, 100, 4)).toBeNull();         // 4% < 5%
    expect(selfPauseReason({ bouncePausePct: 3 }, 100, 4)).toMatch(/the limit is 3%/);
    expect(selfPauseReason({ bouncePausePct: 0 }, 100, 50)).toBeNull();
  });
});
