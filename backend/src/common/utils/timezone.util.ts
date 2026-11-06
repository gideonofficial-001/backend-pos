export const NAIROBI_TIMEZONE = 'Africa/Nairobi';

/**
 * Returns YYYY-MM-DD string for a given date in Africa/Nairobi
 */
export function getNairobiDateString(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: NAIROBI_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Returns UTC Date object representing start of the day (00:00:00.000) in Africa/Nairobi.
 * Since Nairobi is UTC+3, start of day is 21:00:00.000 of the previous day in UTC.
 */
export function getNairobiStartOfDay(dateOrString?: Date | string): Date {
  const dateStr = typeof dateOrString === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOrString)
    ? dateOrString
    : getNairobiDateString(dateOrString ? new Date(dateOrString) : new Date());

  const [year, month, day] = dateStr.split('-').map(Number);
  // Nairobi 00:00:00 is UTC 21:00:00 previous day: Date.UTC(year, month - 1, day, -3, 0, 0, 0)
  return new Date(Date.UTC(year, month - 1, day, -3, 0, 0, 0));
}

/**
 * Returns UTC Date object representing end of the day (23:59:59.999) in Africa/Nairobi.
 * Since Nairobi is UTC+3, end of day is 20:59:59.999 in UTC.
 */
export function getNairobiEndOfDay(dateOrString?: Date | string): Date {
  const dateStr = typeof dateOrString === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOrString)
    ? dateOrString
    : getNairobiDateString(dateOrString ? new Date(dateOrString) : new Date());

  const [year, month, day] = dateStr.split('-').map(Number);
  // Nairobi 23:59:59.999 is UTC 20:59:59.999: Date.UTC(year, month - 1, day, 20, 59, 59, 999)
  return new Date(Date.UTC(year, month - 1, day, 20, 59, 59, 999));
}

/**
 * Returns UTC Date object normalized for Postgres @db.Date fields (UTC midnight)
 */
export function getNairobiCalendarDate(dateOrString?: Date | string): Date {
  const dateStr = typeof dateOrString === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOrString)
    ? dateOrString
    : getNairobiDateString(dateOrString ? new Date(dateOrString) : new Date());

  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}
