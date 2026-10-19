/**
 * A due date is a calendar day, not a timestamp. The brand keeps values that
 * crossed the strict calendar-date validator distinct from arbitrary strings.
 */
declare const canonicalDueDateBrand: unique symbol;

export type CanonicalDueDate = string & {
  readonly [canonicalDueDateBrand]: "CanonicalDueDate";
};

export type DueDateTone = "red" | "amber" | "grey";

/** The tone and short label used by due-date chips. */
export type DueInfo = readonly [tone: DueDateTone, label: string];

/**
 * The viewer's time zone is required. Supplying `now` makes parsing and
 * viewer-relative rules deterministic in tests and scheduled work.
 */
export interface DueDateContext {
  timeZone: string;
  now?: Date;
}

export interface ParsedDueText {
  title: string;
  due: CanonicalDueDate | null;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
] as const;
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
] as const;

const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();
const timezoneAliases = new Map<string, string>();
const supportedTimeZones = (() => {
  const intlWithTimeZones = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  return typeof intlWithTimeZones.supportedValuesOf === "function"
    ? new Set(intlWithTimeZones.supportedValuesOf("timeZone"))
    : null;
})();

/** Return a branded YYYY-MM-DD only when it is a real Gregorian date. */
export const parseCanonicalDueDate = (
  value: unknown
): CanonicalDueDate | null => {
  if (typeof value !== "string") return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCivilDate(year, month, day)) return null;
  return value as CanonicalDueDate;
};

/** Resolve supported due-date phrases to a date in the supplied time zone. */
export const resolveDue = (
  expression: string,
  context: DueDateContext
): CanonicalDueDate | null => {
  const resolved = resolveContext(context);
  if (typeof expression !== "string") return null;

  const phrase = expression
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!phrase) return null;

  const today = localToday(resolved);
  const todayNumber = civilDayNumber(today.year, today.month, today.day);

  if (/^(today|tonight|eod|end of day)$/.test(phrase)) {
    return formatCivilDate(today.year, today.month, today.day);
  }
  if (/^(tomorrow|tmrw)$/.test(phrase)) {
    return addCivilDays(today, 1);
  }
  if (phrase === "next week") {
    const todayWeekday = weekdayNumber(todayNumber);
    const daysUntilMonday = (1 - todayWeekday + 7) % 7 || 7;
    return addCivilDays(today, daysUntilMonday);
  }

  const weekdayExpression = weekdayExpressionParts(phrase);
  if (weekdayExpression) {
    const targetWeekday = weekdayNumberFor(weekdayExpression.weekday);
    if (targetWeekday === null) return null;
    const currentWeekday = weekdayNumber(todayNumber);
    const daysUntil = (targetWeekday - currentWeekday + 7) % 7;
    return addCivilDays(today, daysUntil);
  }

  const monthDay = monthDayExpressionParts(phrase);
  if (!monthDay) return null;

  let year = today.year;
  if (!isValidCivilDate(year, monthDay.month, monthDay.day)) return null;
  let difference =
    civilDayNumber(year, monthDay.month, monthDay.day) - todayNumber;
  if (difference < -60) {
    year += 1;
    if (year > 9999 || !isValidCivilDate(year, monthDay.month, monthDay.day)) {
      return null;
    }
    difference =
      civilDayNumber(year, monthDay.month, monthDay.day) - todayNumber;
  }
  const resolvedDayNumber = civilDayNumber(year, monthDay.month, monthDay.day);
  if (
    difference < -60 ||
    (monthDay.weekday !== null &&
      weekdayNumber(resolvedDayNumber) !== monthDay.weekday)
  ) {
    return null;
  }
  return formatCivilDate(year, monthDay.month, monthDay.day);
};

/**
 * Split a task title from a trailing due marker such as “by Friday” or
 * “— due Thu 22 Oct”. Invalid or unsupported phrases remain part of the title.
 */
export const parseDue = (
  text: string,
  context: DueDateContext
): ParsedDueText => {
  const resolvedContext = resolveContext(context);
  const original = typeof text === "string" ? text.trim() : "";
  const marker =
    /^(.*?)(?:\s+(?:—|–|-)\s+|\s*,\s*|\s*\(\s*|\s+)(?:by|due(?:\s+on)?|before)\s+(.+?)\s*\)?$/i.exec(
      original
    );
  if (!marker) return { title: original, due: null };

  const due = resolveDue(marker[2]!, {
    timeZone: resolvedContext.timeZone,
    now: resolvedContext.now
  });
  if (!due) return { title: original, due: null };
  return { title: marker[1]!.trim(), due };
};

/** Compute the due chip's tone and label using the viewer's local calendar. */
export const dueInfo = (
  dueOn: CanonicalDueDate,
  context: DueDateContext
): DueInfo => {
  const resolved = resolveContext(context);
  const dueDate = requireCanonicalDueDate(dueOn);
  const today = localToday(resolved);
  const daysUntil =
    civilDayNumber(dueDate.year, dueDate.month, dueDate.day) -
    civilDayNumber(today.year, today.month, today.day);

  if (daysUntil < 0) return ["red", `Overdue ${Math.abs(daysUntil)}d`];
  if (daysUntil === 0) return ["red", "Due today"];
  if (daysUntil === 1) return ["amber", "Due tomorrow"];
  if (daysUntil <= 3) return ["amber", `Due ${weekdayLabel(dueDate)}`];
  if (daysUntil < 7) return ["grey", `Due ${weekdayLabel(dueDate)}`];
  return ["grey", `Due ${dueDate.day} ${monthLabel(dueDate.month)}`];
};

/** True for an overdue item, one due today, or one due tomorrow. */
export const dueSoon = (
  dueOn: CanonicalDueDate | null,
  context: DueDateContext
): boolean => {
  const resolved = resolveContext(context);
  if (dueOn === null) return false;
  const dueDate = requireCanonicalDueDate(dueOn);
  const today = localToday(resolved);
  const daysUntil =
    civilDayNumber(dueDate.year, dueDate.month, dueDate.day) -
    civilDayNumber(today.year, today.month, today.day);
  return daysUntil <= 1;
};

interface ResolvedContext {
  timeZone: string;
  now: Date;
  formatter: Intl.DateTimeFormat;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const resolveContext = (context: DueDateContext): ResolvedContext => {
  if (!context || typeof context !== "object") {
    throw new TypeError(
      "A due-date context with an IANA time zone is required."
    );
  }
  const timeZone = normalizeTimeZone(context.timeZone);
  const now = context.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RangeError("Due-date context now must be a valid Date.");
  }
  let formatter = timezoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    timezoneFormatters.set(timeZone, formatter);
  }
  return { timeZone, now: new Date(now.getTime()), formatter };
};

const normalizeTimeZone = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(
      "A due-date context with an IANA time zone is required."
    );
  }
  const input = value.trim();
  const cached = timezoneAliases.get(input);
  if (cached) return cached;

  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", {
      timeZone: input
    }).resolvedOptions().timeZone;
  } catch {
    throw new RangeError(`Invalid IANA time zone: ${input}`);
  }

  const validEtcGmt =
    /^Etc\/GMT(?:\+(?:[0-9]|1[0-2])|-(?:[0-9]|1[0-4]))?$/.test(canonical);
  const isSupported = supportedTimeZones
    ? supportedTimeZones.has(canonical)
    : canonical.includes("/");
  if (canonical !== "UTC" && !validEtcGmt && !isSupported) {
    throw new RangeError(`Invalid IANA time zone: ${input}`);
  }
  timezoneAliases.set(input, canonical);
  return canonical;
};

const localToday = ({ now, formatter }: ResolvedContext): CivilDate => {
  const parts = formatter.formatToParts(now);
  const part = (type: "year" | "month" | "day"): number => {
    const value = parts.find((entry) => entry.type === type)?.value;
    const number = Number(value);
    if (!Number.isInteger(number)) {
      throw new RangeError(
        "The supplied instant cannot be read in this time zone."
      );
    }
    return number;
  };
  const date = { year: part("year"), month: part("month"), day: part("day") };
  if (!isValidCivilDate(date.year, date.month, date.day)) {
    throw new RangeError(
      "The supplied instant is outside the supported calendar range."
    );
  }
  return date;
};

const requireCanonicalDueDate = (value: unknown): CivilDate => {
  const canonical = parseCanonicalDueDate(value);
  if (!canonical) {
    throw new RangeError("Due date must be a valid YYYY-MM-DD calendar date.");
  }
  return civilParts(canonical);
};

const civilParts = (date: CanonicalDueDate): CivilDate => {
  const match = DATE_PATTERN.exec(date);
  if (!match)
    throw new RangeError("Due date must be a valid YYYY-MM-DD calendar date.");
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
};

const weekdayLabel = (date: CivilDate): string => {
  const weekday =
    WEEKDAYS[weekdayNumber(civilDayNumber(date.year, date.month, date.day))]!;
  return `${weekday.slice(0, 1).toUpperCase()}${weekday.slice(1, 3)}`;
};

const monthLabel = (month: number): string => {
  const name = MONTHS[month - 1]!;
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1, 3)}`;
};

const isValidCivilDate = (
  year: number,
  month: number,
  day: number
): boolean => {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return day <= daysInMonth[month - 1]!;
};

/** Integer days from 1970-01-01, calculated without timestamp arithmetic. */
const civilDayNumber = (year: number, month: number, day: number): number => {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
};

const weekdayNumber = (dayNumber: number): number =>
  (((dayNumber + 4) % 7) + 7) % 7;

const addCivilDays = (
  date: CivilDate,
  days: number
): CanonicalDueDate | null => {
  const target = civilDayNumber(date.year, date.month, date.day) + days;
  if (
    target < civilDayNumber(1, 1, 1) ||
    target > civilDayNumber(9999, 12, 31)
  ) {
    return null;
  }
  let low = 1;
  let high = 9999;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (civilDayNumber(middle, 1, 1) <= target) low = middle;
    else high = middle - 1;
  }
  const year = low;
  let ordinal = target - civilDayNumber(year, 1, 1);
  let month = 1;
  while (month <= 12) {
    const monthLength = daysInMonth(year, month);
    if (ordinal < monthLength) return formatCivilDate(year, month, ordinal + 1);
    ordinal -= monthLength;
    month += 1;
  }
  return null;
};

const daysInMonth = (year: number, month: number): number => {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ]!;
};

const formatCivilDate = (
  year: number,
  month: number,
  day: number
): CanonicalDueDate =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CanonicalDueDate;

const weekdayExpressionParts = (phrase: string): { weekday: string } | null => {
  const match = /^(?:(?:this|next)\s+)?([a-z]+)$/.exec(phrase);
  if (!match || weekdayNumberFor(match[1]!) === null) return null;
  return { weekday: match[1]! };
};

const monthDayExpressionParts = (
  phrase: string
): { month: number; day: number; weekday: number | null } | null => {
  let normalized = phrase;
  normalized = normalized.replace(/^(?:this|next)\s+/, "");
  const words = normalized.split(" ");
  let weekday: number | null = null;

  if (words.length === 3) {
    weekday = weekdayNumberFor(words[0]!);
    if (weekday !== null) words.shift();
  }
  if (words.length === 2) {
    if (/^\d{1,2}$/.test(words[0]!)) {
      const month = monthNumberFor(words[1]!);
      return month === null ? null : { month, day: Number(words[0]!), weekday };
    }
    if (/^\d{1,2}$/.test(words[1]!)) {
      const month = monthNumberFor(words[0]!);
      return month === null ? null : { month, day: Number(words[1]!), weekday };
    }
    return null;
  }

  if (words.length !== 1) return null;
  const compact = words[0]!;
  let match = /^(\d{1,2})([a-z]+)$/.exec(compact);
  if (match) {
    const month = monthNumberFor(match[2]!);
    return month === null
      ? null
      : { month, day: Number(match[1]!), weekday: null };
  }
  match = /^([a-z]+)(\d{1,2})$/.exec(compact);
  if (match) {
    const month = monthNumberFor(match[1]!);
    return month === null
      ? null
      : { month, day: Number(match[2]!), weekday: null };
  }
  match = /^([a-z]+)(\d{1,2})([a-z]+)$/.exec(compact);
  if (match) {
    const compactWeekday = weekdayNumberFor(match[1]!);
    if (compactWeekday === null) return null;
    const month = monthNumberFor(match[3]!);
    return month === null
      ? null
      : {
          month,
          day: Number(match[2]!),
          weekday: compactWeekday
        };
  }
  return null;
};

const monthNumberFor = (name: string): number | null => {
  const normalized = name.toLowerCase();
  const index = MONTHS.findIndex(
    (month) => normalized === month || normalized === month.slice(0, 3)
  );
  return index < 0 ? null : index + 1;
};

const weekdayNumberFor = (name: string): number | null => {
  const normalized = name.toLowerCase();
  const index = WEEKDAYS.findIndex(
    (weekday) => normalized === weekday || normalized === weekday.slice(0, 3)
  );
  return index < 0 ? null : index;
};
