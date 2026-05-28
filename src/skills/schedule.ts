// swrm/src/skills/schedule.ts — turn a Skill Card frequency string into the
// next due timestamp. Times are LOCAL (D-2: swrm is a localhost dev tool).
//
// Grammar (v1): @hourly | @daily | "@daily HH:MM" | Nh | Nm | weekly:<dow>
//
// nextDue returns the next slot strictly after the reference (lastRun ?? now).
// It is NOT clamped to the future: a far-past lastRun yields an overdue slot.
// The orchestrator (US-007) collapses missed runs by re-scheduling from `now`
// after it runs the catch-up once.

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;

const DOW: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function nextDailyAt(ref: Date, hh: number, mm: number): Date {
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`invalid daily time ${hh}:${mm} (expected 00:00–23:59)`);
  }
  const d = new Date(ref);
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= ref.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

function nextWeekday(ref: Date, name: string): Date {
  const target = DOW[name.toLowerCase()];
  if (target === undefined) throw new Error(`unknown weekday '${name}'`);
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() !== target);
  return d;
}

export function nextDue(frequency: string, lastRun: Date | null, now: Date): Date {
  const ref = lastRun ?? now;
  const f = frequency.trim();

  if (f === '@hourly') return new Date(ref.getTime() + HOUR_MS);
  if (f === '@daily') return new Date(ref.getTime() + DAY_MS);

  const dailyAt = f.match(/^@daily\s+(\d{1,2}):(\d{2})$/);
  if (dailyAt) return nextDailyAt(ref, Number(dailyAt[1]), Number(dailyAt[2]));

  const hours = f.match(/^(\d+)h$/);
  if (hours) return new Date(ref.getTime() + Number(hours[1]) * HOUR_MS);

  const mins = f.match(/^(\d+)m$/);
  if (mins) return new Date(ref.getTime() + Number(mins[1]) * 60_000);

  const weekly = f.match(/^weekly:(\w+)$/);
  if (weekly) return nextWeekday(ref, weekly[1]);

  throw new Error(`unknown frequency '${frequency}'`);
}
