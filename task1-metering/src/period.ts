export type Period = 'hour' | 'day' | 'month';

export interface PeriodBounds {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** Fixed, calendar-aligned UTC windows, so periods match billing cycles and ignore DST. */
export function periodBounds(now: Date, period: Period): PeriodBounds {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const h = now.getUTCHours();

  switch (period) {
    case 'hour':
      return { start: new Date(Date.UTC(y, m, d, h)), end: new Date(Date.UTC(y, m, d, h + 1)) };
    case 'day':
      return { start: new Date(Date.UTC(y, m, d)), end: new Date(Date.UTC(y, m, d + 1)) };
    case 'month':
      return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
  }
}
