/**
 * Timestamp helpers for date-picker fields.
 * Uses APP_TIMEZONE (default Asia/Kolkata) so "Aug 2" does not shift to Aug 1.
 */

const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";

/** Fixed UTC offsets in minutes (no DST for these). */
const ZONE_OFFSET_MINUTES = {
  "Asia/Kolkata": 330,
  "Asia/Calcutta": 330,
  UTC: 0,
  "Etc/UTC": 0,
};

function getOffsetMinutes(timeZone = APP_TIMEZONE) {
  if (Object.prototype.hasOwnProperty.call(ZONE_OFFSET_MINUTES, timeZone)) {
    return ZONE_OFFSET_MINUTES[timeZone];
  }
  // Fallback: compute offset for "now"
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).format(new Date());
  const match = formatted.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return 330;
  const hours = Number(match[1]);
  const mins = Number(match[2] || 0);
  return hours * 60 + Math.sign(hours || 1) * mins;
}

function getZonedCalendarParts(date, timeZone = APP_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const get = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : NaN;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
  };
}

/** Local calendar midnight → UTC ISO (e.g. Aug 2 00:00 IST → Aug 1 18:30Z) */
function zonedMidnightIso(year, month, day, timeZone = APP_TIMEZONE) {
  const offset = getOffsetMinutes(timeZone);
  return new Date(
    Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offset * 60 * 1000
  ).toISOString();
}

function zonedEndOfDayIso(year, month, day, timeZone = APP_TIMEZONE) {
  const offset = getOffsetMinutes(timeZone);
  return new Date(
    Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offset * 60 * 1000
  ).toISOString();
}

/**
 * Store/return calendar days at UTC noon so both:
 * - Asia/Kolkata datepickers, and
 * - naive UTC displays (toISOString().slice(0,10))
 * keep the same calendar day (Aug 2 stays Aug 2).
 */
function calendarDayUtcNoonIso(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0)).toISOString();
}

function calendarDayUtcNoonEpoch(year, month, day) {
  return Date.UTC(year, month - 1, day, 12, 0, 0, 0);
}

function nowTimestamp() {
  return new Date().toISOString();
}

function toDateObject(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const raw = String(value).trim();
  if (!raw) return undefined;

  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    return new Date(calendarDayUtcNoonIso(y, m, d));
  }

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Normalize any input to the calendar day in APP_TIMEZONE,
 * stored as UTC noon of that calendar day.
 */
function parseTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  // Explicit calendar date string — trust the Y-M-D as chosen by user
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const [y, m, d] = value.trim().split("-").map(Number);
    return calendarDayUtcNoonIso(y, m, d);
  }

  const dateObj = toDateObject(value);
  if (dateObj === undefined) return undefined;
  if (dateObj === null) return null;

  const { year, month, day } = getZonedCalendarParts(dateObj);
  if (!year || !month || !day) return null;
  return calendarDayUtcNoonIso(year, month, day);
}

/**
 * API response: epoch ms at UTC noon of the calendar day in APP_TIMEZONE.
 */
function formatTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;

  const dateObj = toDateObject(value);
  if (!dateObj) return null;

  const { year, month, day } = getZonedCalendarParts(dateObj);
  if (!year || !month || !day) return null;

  return calendarDayUtcNoonEpoch(year, month, day);
}

function dayStart(value) {
  const iso = parseTimestamp(value);
  return iso || null;
}

function dayEnd(value) {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const [y, m, d] = value.trim().split("-").map(Number);
    return zonedEndOfDayIso(y, m, d);
  }

  const dateObj = toDateObject(value);
  if (!dateObj) return null;
  const { year, month, day } = getZonedCalendarParts(dateObj);
  return zonedEndOfDayIso(year, month, day);
}

function monthRangeTimestamps(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: zonedMidnightIso(year, month, 1),
    end: zonedEndOfDayIso(year, month, lastDay),
  };
}

module.exports = {
  APP_TIMEZONE,
  nowTimestamp,
  parseTimestamp,
  formatTimestamp,
  dayStart,
  dayEnd,
  monthRangeTimestamps,
  toDateObject,
  getZonedCalendarParts,
};
