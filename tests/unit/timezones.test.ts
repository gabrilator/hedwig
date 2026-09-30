import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { isTimezone, timezones } from '../../src/lib/server/timezones';

describe('timezones', () => {
  it('lists IANA zones plus UTC, sorted, with no duplicates', () => {
    const z = timezones();
    expect(z).toContain('UTC');
    expect(z).toContain('Europe/Madrid');
    expect(z).toContain('America/Toronto');
    expect(new Set(z).size).toBe(z.length);
    expect([...z].sort()).toEqual(z);
  });
  it('every listed zone is one the planner (luxon) can schedule in', () => {
    for (const tz of timezones()) expect(DateTime.now().setZone(tz).isValid, tz).toBe(true);
  });
  it('validates aliases the browser may send and rejects junk', () => {
    expect(isTimezone('Europe/Kyiv')).toBe(true);
    expect(isTimezone('Etc/UTC')).toBe(true);
    expect(isTimezone('Mars/Olympus')).toBe(false);
    expect(isTimezone('')).toBe(false);
    expect(isTimezone('Europe/Lisbon')).toBe(true);
  });
});

describe('timezone offsets', async () => {
  const { fixedOffsets, formatOffset, timezoneOptions } = await import('../../src/lib/server/timezones');
  it('formats offsets the way people say them', () => {
    expect(formatOffset(0)).toBe('UTC');
    expect(formatOffset(120)).toBe('UTC+2');
    expect(formatOffset(-240)).toBe('UTC−4');
    expect(formatOffset(330)).toBe('UTC+5:30');
    expect(formatOffset(-210)).toBe('UTC−3:30');
  });
  it('gives every city its current offset and lists fixed offsets the scheduler can use', () => {
    const summer = new Date('2026-07-15T12:00:00Z');
    const winter = new Date('2026-01-15T12:00:00Z');
    const madridSummer = timezoneOptions(summer).find((o) => o.zone === 'Europe/Madrid');
    expect(madridSummer?.offset).toBe('UTC+2');
    const madridWinter = timezoneOptions(new Date(winter.getTime() + 1)).find((o) => o.zone === 'Europe/Madrid');
    expect(madridWinter?.offset).toBe('UTC+1');
    const toronto = timezoneOptions(new Date(summer.getTime() + 2)).find((o) => o.zone === 'America/Toronto');
    expect(toronto?.offset).toBe('UTC−4');
    const fixed = fixedOffsets();
    expect(fixed.map((f) => f.offset)).toContain('UTC+2');
    expect(fixed.find((f) => f.offset === 'UTC+2')?.zone).toBe('Etc/GMT-2');
    for (const f of fixed) expect(isTimezone(f.zone), f.zone).toBe(true);
    expect(DateTime.fromJSDate(summer, { zone: 'Etc/GMT-2' }).offset).toBe(120);
    expect(timezoneOptions(summer).filter((o) => o.zone === 'UTC')).toHaveLength(1);
  });
});
