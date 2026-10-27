/**
 * Date arithmetic for the assistant (P3).
 *
 * Dates are handled as UTC calendar days. Côte d'Ivoire is on UTC+0 all year,
 * so the UTC day is also the local day in Abidjan. No legal rule is encoded
 * here: the function only computes a calendar date.
 */

export const ABIDJAN_TIME_ZONE = 'Africa/Abidjan';

const WEEKDAYS: Record<string, number> = {
  dimanche: 0,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export interface DateAddition {
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
}

export interface ComputeDateInput {
  /** "today", "next_monday", "lundi prochain", "2026-10-27", "27/10/2026". */
  start?: string;
  add?: DateAddition;
  /** A period counted from the start day ends the day before the anniversary. */
  inclusive?: boolean;
  /** Reference instant (tests and server clock). */
  now?: Date;
}

export interface ComputedDate {
  start: string;
  end: string;
  iso: string;
  weekday: string;
  formatted: string;
  inclusive: boolean;
  addition: DateAddition;
}

export type DateResult =
  | { ok: true; value: ComputedDate }
  | { ok: false; error: string };

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return new Date(Number.NaN);
  }
  return date;
}

function abidjanParts(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ABIDJAN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function todayInAbidjan(now: Date): Date {
  const parts = abidjanParts(now);
  return utcDate(parts.year, parts.month, parts.day);
}

function normalizeStart(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseStartDate(raw: string | undefined, now: Date): Date | null {
  const value = normalizeStart(raw ?? 'today');
  if (!value || value === 'today' || value === 'aujourd hui' || value === 'ce jour') {
    return todayInAbidjan(now);
  }
  if (value === 'tomorrow' || value === 'demain') {
    return addDays(todayInAbidjan(now), 1);
  }
  if (value === 'yesterday' || value === 'hier') {
    return addDays(todayInAbidjan(now), -1);
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const french = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (french) return utcDate(Number(french[3]), Number(french[2]), Number(french[1]));

  const weekdayMatch = /^(?:(next|prochain|prochaine)\s+)?(dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi|sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(prochain|prochaine))?$/.exec(value);
  if (weekdayMatch) {
    const target = WEEKDAYS[weekdayMatch[2]!]!;
    const current = todayInAbidjan(now);
    let delta = (target - current.getUTCDay() + 7) % 7;
    // "next Monday" is always strictly in the future, including on Monday.
    if (delta === 0) delta = 7;
    return addDays(current, delta);
  }

  return null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const first = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay)));
}

function integer(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value;
}

function readAddition(raw: unknown): DateAddition | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const addition: DateAddition = {};
  for (const key of ['years', 'months', 'weeks', 'days'] as const) {
    if (source[key] === undefined) continue;
    const value = integer(source[key]);
    if (value === null || Math.abs(value) > 1000) return null;
    addition[key] = value;
  }
  return addition;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function frenchDate(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Computes a calendar date and its formatted French representation. */
export function computeDate(input: ComputeDateInput = {}): DateResult {
  const now = input.now ?? new Date();
  const start = parseStartDate(input.start, now);
  if (!start || Number.isNaN(start.getTime())) {
    return {
      ok: false,
      error: 'Date de départ non reconnue. Utilise « today », « next_monday », « 2026-10-27 » ou « 27/10/2026 ».',
    };
  }

  const addition = readAddition(input.add);
  if (!addition) {
    return {
      ok: false,
      error: 'Le décalage doit contenir des nombres entiers (years, months, weeks, days).',
    };
  }

  let end = new Date(start.getTime());
  if (addition.years) end = addMonths(end, addition.years * 12);
  if (addition.months) end = addMonths(end, addition.months);
  if (addition.weeks) end = addDays(end, addition.weeks * 7);
  if (addition.days) end = addDays(end, addition.days);

  const inclusive = input.inclusive === true;
  const hasAddition = Boolean(addition.years || addition.months || addition.weeks || addition.days);
  if (inclusive && hasAddition) end = addDays(end, -1);

  const weekday = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(end);

  return {
    ok: true,
    value: {
      start: isoDate(start),
      end: isoDate(end),
      iso: isoDate(end),
      weekday,
      formatted: frenchDate(end),
      inclusive,
      addition,
    },
  };
}
