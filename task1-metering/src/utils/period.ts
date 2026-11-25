import type { Period, PeriodBounds } from '../types/index.js';

/** Fixed, calendar-aligned UTC windows: they match billing cycles and ignore DST. */
export function periodBounds(now: Date, period: Period): PeriodBounds {
  const [y, m, d, h] = [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()];
  const [start, end] = {
    hour: [Date.UTC(y, m, d, h), Date.UTC(y, m, d, h + 1)],
    day: [Date.UTC(y, m, d), Date.UTC(y, m, d + 1)],
    month: [Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1)],
  }[period];
  return { start: new Date(start!).toISOString(), end: new Date(end!).toISOString() };
}
