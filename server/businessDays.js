// server/businessDays.js
// Phase 2 manual-review trigger: "requested deadline is less than 3 business
// days away." Deliberately simple per the rebuild plan's own scope note —
// Mon-Fri counted as business days, no holiday calendar.

/**
 * Number of business days (Mon-Fri) strictly between `from` (exclusive) and
 * `to` (inclusive) — i.e. how many business days remain before/on the
 * deadline if you start counting tomorrow. Returns 0 for a deadline that's
 * today or in the past.
 */
function businessDaysUntil(toDate, fromDate = new Date()) {
  const from = startOfDay(fromDate);
  const to = startOfDay(toDate);
  if (to <= from) return 0;
  let count = 0;
  const cursor = new Date(from);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor <= to) {
    const dow = cursor.getDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

function startOfDay(d) {
  const date = d instanceof Date ? new Date(d) : new Date(d);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** True if `neededByDateStr` (YYYY-MM-DD or any Date-parseable string) is
 * fewer than `thresholdBusinessDays` business days away from now. A missing/
 * unparseable date is never "tight" — no deadline given means nothing to flag. */
function isTightDeadline(neededByDateStr, thresholdBusinessDays = 3) {
  if (!neededByDateStr) return false;
  const parsed = new Date(neededByDateStr);
  if (isNaN(parsed.getTime())) return false;
  return businessDaysUntil(parsed) < thresholdBusinessDays;
}

module.exports = { businessDaysUntil, isTightDeadline };
