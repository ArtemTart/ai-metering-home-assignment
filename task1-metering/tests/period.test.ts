import { describe, expect, it } from 'vitest';
import { periodBounds } from '../src/period.js';

const iso = (d: Date) => d.toISOString();

describe('periodBounds', () => {
  it('aligns hourly windows to the UTC hour', () => {
    const { start, end } = periodBounds(new Date('2026-03-15T12:34:56.789Z'), 'hour');
    expect(iso(start)).toBe('2026-03-15T12:00:00.000Z');
    expect(iso(end)).toBe('2026-03-15T13:00:00.000Z');
  });

  it('aligns daily windows to UTC midnight', () => {
    const { start, end } = periodBounds(new Date('2026-03-15T23:59:59.999Z'), 'day');
    expect(iso(start)).toBe('2026-03-15T00:00:00.000Z');
    expect(iso(end)).toBe('2026-03-16T00:00:00.000Z');
  });

  it('rolls monthly windows over the year boundary', () => {
    const { start, end } = periodBounds(new Date('2026-12-31T23:59:59.999Z'), 'month');
    expect(iso(start)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(end)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles February in a leap year', () => {
    const { end } = periodBounds(new Date('2028-02-29T10:00:00.000Z'), 'month');
    expect(iso(end)).toBe('2028-03-01T00:00:00.000Z');
  });

  it('puts the exact boundary instant in the new period (start inclusive, end exclusive)', () => {
    const { start } = periodBounds(new Date('2026-04-01T00:00:00.000Z'), 'month');
    expect(iso(start)).toBe('2026-04-01T00:00:00.000Z');
  });

  it('is unaffected by DST because everything is UTC', () => {
    // 2026-03-29 is the EU DST switch; the UTC day is still exactly 24h.
    const { start, end } = periodBounds(new Date('2026-03-29T05:00:00.000Z'), 'day');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
