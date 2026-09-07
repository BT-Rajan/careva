import moment, { Moment } from 'moment';

/**
 * Adversarial stress-test finding (post Pass 26): this app had zero timezone handling
 * anywhere — every "is this date in the past", "which weekday is this", and cutoff
 * calculation used bare `moment()` / `new Date()`, which reflect the Node process's
 * *system* clock, not Kuwait's. On real hosting that's very often UTC (the default
 * system timezone for most Linux/Docker images, regardless of which region the server
 * physically sits in) — three hours behind Kuwait. Around each Kuwait midnight, that
 * three-hour gap means the server's idea of "today" lags a full calendar day behind
 * the patient's, which can affect which one-off doctor-blocked dates count as past vs.
 * current, which weekday a booking's capacity lock matches against, and when the
 * appointment/payment-expiry background jobs (Pass 23) fire relative to an actual
 * Kuwait appointment time.
 *
 * Kuwait (Asia/Kuwait) has observed a single fixed UTC+03:00 offset with no daylight
 * saving time for its entire modern history — so unlike most timezones, this does NOT
 * need a full IANA tz database (moment-timezone, Intl timeZone lookups, etc). One
 * constant, applied consistently, is sufficient and correct.
 *
 * Anything in this codebase that means "the current date/time AS EXPERIENCED IN
 * KUWAIT" — today's date for filtering blocked/past dates, the weekday a booking
 * falls on, "is this appointment's scheduled time still in the future" — should go
 * through this module rather than a bare `moment()`.
 *
 * `scheduleDate`/`DoctorBlockedDate.date` are stored as plain "YYYY-MM-DD" strings
 * (see Pass 1 / Pass 11's schema comments), specifically to sidestep DateTime-column
 * timezone drift. Where a comparison is purely between two such date-only strings,
 * prefer plain string comparison (`===`, `<`, `>`) over parsing either one through
 * moment — ISO `YYYY-MM-DD` strings sort and compare correctly as plain strings, and
 * this avoids moment's own well-known gotcha of parsing date-only strings as UTC while
 * formatting/comparing them in local time.
 */
export const KUWAIT_UTC_OFFSET_MINUTES = 180;

/** The current instant, expressed in Kuwait's fixed UTC+3 offset. */
export const nowInKuwait = (): Moment => moment().utcOffset(KUWAIT_UTC_OFFSET_MINUTES);

/** Today's calendar date in Kuwait, as "YYYY-MM-DD" — for direct string comparison
 * against stored `scheduleDate` / `DoctorBlockedDate.date` values. */
export const todayInKuwait = (): string => nowInKuwait().format('YYYY-MM-DD');

/** Current weekday name in Kuwait, lowercased, matching this app's `Day` enum values
 * ("monday", "tuesday", ...). */
export const currentWeekdayInKuwait = (): string => nowInKuwait().format('dddd').toLowerCase();

/**
 * Extracts the "YYYY-MM-DD" calendar-date portion from a stored `scheduleDate` value,
 * which (per Pass 1/11's schema comments) may arrive either as a bare date string
 * ("2026-08-20") or a date-with-time string ("2026-08-20 00:00:00").
 */
export const dateOnly = (scheduleDate: string): string => scheduleDate.slice(0, 10);

/**
 * Given an already-known calendar date (as a "YYYY-MM-DD" string, or the date portion
 * of a longer one), returns which weekday it falls on — lowercased, matching this
 * app's `Day` enum. Deliberately parsed with `moment.utc(...)` and formatted without
 * ever calling `.local()`: a calendar date's weekday is an intrinsic property of the
 * date itself and must NOT depend on the server process's system timezone. Plain
 * `moment(dateString).format('dddd')` is exactly the bug this avoids — moment parses a
 * bare ISO date-only string as UTC-midnight but *formats* it back in the server's
 * local zone, which can silently roll the date (and therefore the weekday) back by one
 * day on any server whose local zone sits west of UTC. Using `moment.utc(...)` for
 * both the parse and the format keeps the whole computation in one zone, so there is
 * no conversion step left to get wrong.
 */
export const weekdayOf = (scheduleDate: string): string =>
    moment.utc(dateOnly(scheduleDate), 'YYYY-MM-DD').format('dddd').toLowerCase();
