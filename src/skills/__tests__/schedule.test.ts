// US-004 — frequency parser -> next_due (local time, D-2).

import { nextDue } from '../schedule';

const ref = new Date(2026, 4, 27, 10, 0, 0); // Wed 2026-05-27 10:00 local

describe('nextDue', () => {
  it('@hourly adds one hour to the reference', () => {
    const d = nextDue('@hourly', ref, ref);
    expect(d.getTime()).toBe(ref.getTime() + 3600_000);
  });

  it('Nh adds N hours', () => {
    expect(nextDue('6h', ref, ref).getTime()).toBe(ref.getTime() + 6 * 3600_000);
  });

  it('Nm adds N minutes', () => {
    expect(nextDue('30m', ref, ref).getTime()).toBe(ref.getTime() + 30 * 60_000);
  });

  it('@daily (no time) adds 24h', () => {
    expect(nextDue('@daily', ref, ref).getTime()).toBe(ref.getTime() + 86_400_000);
  });

  it('@daily HH:MM picks the next local HH:MM after the reference', () => {
    const d = nextDue('@daily 07:00', ref, ref); // 07:00 already passed at 10:00 -> tomorrow
    expect(d.getHours()).toBe(7);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(28);
  });

  it('@daily HH:MM stays same day when the time is still ahead', () => {
    const early = new Date(2026, 4, 27, 6, 0, 0);
    const d = nextDue('@daily 07:00', early, early);
    expect(d.getDate()).toBe(27);
    expect(d.getHours()).toBe(7);
  });

  it('weekly:<dow> returns the next occurrence of that weekday', () => {
    const d = nextDue('weekly:mon', ref, ref); // Wed -> next Mon = Jun 1
    expect(d.getDay()).toBe(1);
    expect(d.getTime()).toBeGreaterThan(ref.getTime());
  });

  it('uses now as the reference when lastRun is null', () => {
    const now = new Date(2026, 4, 27, 9, 0, 0);
    expect(nextDue('@hourly', null, now).getTime()).toBe(now.getTime() + 3600_000);
  });

  it('a missed run (lastRun far in past) yields an overdue next_due', () => {
    const farPast = new Date(2026, 0, 1, 0, 0, 0);
    const now = new Date(2026, 4, 27, 10, 0, 0);
    const d = nextDue('@hourly', farPast, now);
    // raw next slot after lastRun, not clamped — orchestrator collapses catch-up
    expect(d.getTime()).toBe(farPast.getTime() + 3600_000);
    expect(d.getTime()).toBeLessThan(now.getTime());
  });

  it('throws on an unknown frequency', () => {
    expect(() => nextDue('banana', ref, ref)).toThrow(/unknown frequency/);
  });

  it('throws on an out-of-range daily time', () => {
    expect(() => nextDue('@daily 25:00', ref, ref)).toThrow();
  });
});
