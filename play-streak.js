(function exposeWordrushPlayStreak(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushPlayStreak = api;
})(globalThis, () => {
  const MAX_PLAY_DATES = 400;

  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }

  function daysInMonth(year, month) {
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function calendarParts(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth(year, month)
    )
      return null;
    const canonical =
      String(year).padStart(4, "0") +
      "-" +
      String(month).padStart(2, "0") +
      "-" +
      String(day).padStart(2, "0");
    return canonical === value ? { year, month, day } : null;
  }

  // Proleptic Gregorian civil-day ordinal. It advances by one for each
  // calendar day without depending on local timezone offsets or DST.
  function calendarOrdinal(year, month, day) {
    const adjustedYear = year - (month <= 2 ? 1 : 0);
    const era = Math.floor(adjustedYear / 400);
    const yearOfEra = adjustedYear - era * 400;
    const dayOfYear = Math.floor(
      (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5,
    ) + day - 1;
    const dayOfEra =
      yearOfEra * 365 +
      Math.floor(yearOfEra / 4) -
      Math.floor(yearOfEra / 100) +
      dayOfYear;
    return era * 146097 + dayOfEra;
  }

  function localDateKey(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.valueOf())) return null;
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    if (year < 0 || year > 9999) return null;
    const key =
      String(year).padStart(4, "0") +
      "-" +
      String(month).padStart(2, "0") +
      "-" +
      String(day).padStart(2, "0");
    return calendarParts(key) ? key : null;
  }

  function normalizePlayDates(days) {
    if (!Array.isArray(days)) return [];
    return [...new Set(days.filter((day) => calendarParts(day)).map(String))]
      .sort()
      .slice(-MAX_PLAY_DATES);
  }

  function calculateCurrentStreak(days, today = new Date()) {
    const todayKey = localDateKey(today);
    if (!todayKey) return 0;
    const todayParts = calendarParts(todayKey);
    const normalized = normalizePlayDates(days);
    const ordinals = new Set(
      normalized.map((day) => {
        const parts = calendarParts(day);
        return calendarOrdinal(parts.year, parts.month, parts.day);
      }),
    );
    const todayOrdinal = calendarOrdinal(
      todayParts.year,
      todayParts.month,
      todayParts.day,
    );
    let anchor = ordinals.has(todayOrdinal)
      ? todayOrdinal
      : ordinals.has(todayOrdinal - 1)
        ? todayOrdinal - 1
        : null;
    if (anchor === null) return 0;
    let streak = 0;
    while (ordinals.has(anchor)) {
      streak++;
      anchor--;
    }
    return streak;
  }

  return Object.freeze({
    MAX_PLAY_DATES,
    calculateCurrentStreak,
    localDateKey,
    normalizePlayDates,
  });
});
