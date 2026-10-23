import type { DailyDownloads } from '../fireside/schemas.js';
import { ToolInputError } from './errors.js';

/** Fireside answers at most this many days per request. */
export const MAX_DAYS_PER_REQUEST = 90;
/** One tool call combines requests up to a year; longer periods are asked for in parts. */
export const MAX_DAYS_PER_CALL = 366;

const DAY_MS = 86_400_000;

// Calendar days carry no time zone of their own, so the arithmetic is done in UTC.
function toTime(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function toDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** The number of days from `start` to `end`, counting both. */
export function daysBetween(start: string, end: string): number {
  return Math.round((toTime(end) - toTime(start)) / DAY_MS) + 1;
}

/** Today's date in UTC; the podcast's own date is at most a day either side of it. */
export function utcToday(): string {
  return toDay(Date.now());
}

/**
 * Splits an inclusive range into requests Fireside accepts, oldest first. The remainder comes first, so every
 * later request is a full 90 days and the last one ends on `end`.
 */
export function planDailyRanges(start: string, end: string): Array<{ start_date: string; end_date: string }> {
  const days = daysBetween(start, end);
  if (days < 1) {
    throw new ToolInputError(`start_date ${start} is after end_date ${end}. Give an end_date on or after start_date.`);
  }
  if (days > MAX_DAYS_PER_CALL) {
    throw new ToolInputError(
      `${start} to ${end} is ${days} days; one call covers at most a year (${MAX_DAYS_PER_CALL} days). ` +
        'Split the period into parts of at most a year and call fireside_get_daily_downloads for each.',
    );
  }
  const ranges: Array<{ start_date: string; end_date: string }> = [];
  let from = toTime(start);
  const first = days % MAX_DAYS_PER_REQUEST || MAX_DAYS_PER_REQUEST;
  for (let size = first; from <= toTime(end); size = MAX_DAYS_PER_REQUEST) {
    const to = from + (size - 1) * DAY_MS;
    ranges.push({ start_date: toDay(from), end_date: toDay(to) });
    from = to + DAY_MS;
  }
  return ranges;
}

/** Joins consecutive responses, oldest first, into one set of days and totals. */
export function mergeDaily(parts: DailyDownloads[]) {
  const first = parts[0]!;
  const last = parts.at(-1)!;
  return {
    days: parts.flatMap((p) => p.data),
    start_date: first.meta.start_date,
    end_date: last.meta.end_date,
    time_zone: first.meta.time_zone,
    downloads: parts.reduce((n, p) => n + p.meta.downloads, 0),
    spotify: parts.reduce((n, p) => n + p.meta.spotify, 0),
    total: parts.reduce((n, p) => n + p.meta.total, 0),
  };
}
