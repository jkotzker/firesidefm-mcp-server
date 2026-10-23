import { describe, expect, it } from 'vitest';

import type { DailyDownloads } from '../src/fireside/schemas.js';
import { daysBetween, mergeDaily, planDailyRanges } from '../src/tools/daily.js';
import { ToolInputError } from '../src/tools/errors.js';

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('daysBetween', () => {
  it('counts both ends, including a leap day', () => {
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(1);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(3);
  });
});

describe('planDailyRanges', () => {
  it('asks for 90 days in one request', () => {
    expect(planDailyRanges('2026-01-01', '2026-03-31')).toEqual([{ start_date: '2026-01-01', end_date: '2026-03-31' }]);
  });

  it('splits 91 days into the remainder first, then a full 90 days ending on the last day', () => {
    expect(planDailyRanges('2026-01-01', '2026-04-01')).toEqual([
      { start_date: '2026-01-01', end_date: '2026-01-01' },
      { start_date: '2026-01-02', end_date: '2026-04-01' },
    ]);
  });

  it('covers 366 days in five requests with no gaps or overlaps', () => {
    const ranges = planDailyRanges('2027-03-01', '2028-02-29');
    expect(ranges).toHaveLength(5);
    expect(ranges[0]!.start_date).toBe('2027-03-01');
    expect(ranges.at(-1)!.end_date).toBe('2028-02-29');
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.start_date).toBe(nextDay(ranges[i - 1]!.end_date));
    for (const r of ranges) expect(daysBetween(r.start_date, r.end_date)).toBeLessThanOrEqual(90);
    expect(ranges.reduce((n, r) => n + daysBetween(r.start_date, r.end_date), 0)).toBe(366);
  });

  it('refuses more than a year', () => {
    expect(() => planDailyRanges('2026-01-01', '2027-01-02')).toThrow(ToolInputError);
    expect(() => planDailyRanges('2026-01-01', '2027-01-02')).toThrow(/year/);
  });

  it('refuses a start after the end', () => {
    expect(() => planDailyRanges('2026-02-02', '2026-02-01')).toThrow(ToolInputError);
  });
});

describe('mergeDaily', () => {
  const part = (days: [string, number, number][], timeZone = 'UTC'): DailyDownloads => ({
    data: days.map(([day, downloads, spotify]) => ({ day, downloads, spotify, total: downloads + spotify })),
    meta: {
      start_date: days[0]![0],
      end_date: days.at(-1)![0],
      time_zone: timeZone,
      downloads: days.reduce((n, d) => n + d[1], 0),
      spotify: days.reduce((n, d) => n + d[2], 0),
      total: days.reduce((n, d) => n + d[1] + d[2], 0),
    },
  });

  it('joins the days in order and adds up the totals', () => {
    const merged = mergeDaily([
      part([['2026-01-01', 10, 1]], 'Eastern Time (US & Canada)'),
      part([['2026-01-02', 20, 2], ['2026-01-03', 30, 3]], 'Eastern Time (US & Canada)'),
    ]);
    expect(merged.days.map((d) => d.day)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(merged).toMatchObject({
      start_date: '2026-01-01',
      end_date: '2026-01-03',
      time_zone: 'Eastern Time (US & Canada)',
      downloads: 60,
      spotify: 6,
      total: 66,
    });
  });
});
