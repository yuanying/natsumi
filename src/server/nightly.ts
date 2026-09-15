/**
 * Wall-clock times in the owner's time zone, for the nightly session switch (ADR 0009). A later scheduler can take
 * these over; nothing here keeps state.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, format);
  }
  return format;
}

interface LocalTime { year: number; month: number; day: number; hour: number; minute: number; second: number }

function local(ms: number, timeZone: string): LocalTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(ms).map(part => [part.type, part.value]));
  return { year: +parts.year!, month: +parts.month!, day: +parts.day!, hour: +parts.hour!, minute: +parts.minute!, second: +parts.second! };
}

/** How far the zone's wall clock is ahead of UTC at this instant. */
function offset(ms: number, timeZone: string): number {
  const t = local(ms, timeZone);
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant a local date and time happens. Day overflow (such as day 0) rolls into the neighbouring month. */
function instant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offset(wall, timeZone);
  return wall - offset(first, timeZone);
}

export function isValidTimeZone(timeZone: string): boolean {
  try { formatter(timeZone); return true; } catch { return false; }
}

/** `HH:MM`, 24-hour. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clock(at: string): [number, number] {
  const match = TIME_OF_DAY.exec(at);
  if (!match) throw new Error('time of day must be HH:MM');
  return [Number(match[1]), Number(match[2])];
}

/** The latest time `at` happened at or before `now`. */
export function previousOccurrence(now: number, at: string, timeZone: string): number {
  const [hour, minute] = clock(at);
  const today = local(now, timeZone);
  const candidate = instant(today.year, today.month, today.day, hour, minute, timeZone);
  return candidate <= now ? candidate : instant(today.year, today.month, today.day - 1, hour, minute, timeZone);
}

/** The first time `at` happens after `now`. */
export function nextOccurrence(now: number, at: string, timeZone: string): number {
  const [hour, minute] = clock(at);
  const today = local(now, timeZone);
  const candidate = instant(today.year, today.month, today.day, hour, minute, timeZone);
  return candidate > now ? candidate : instant(today.year, today.month, today.day + 1, hour, minute, timeZone);
}

/** `YYYY-MM-DD` in the time zone. */
export function localDate(ms: number, timeZone: string): string {
  const t = local(ms, timeZone);
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}
