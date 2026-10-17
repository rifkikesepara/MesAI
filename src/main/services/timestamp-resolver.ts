import type { TimestampConfidence } from '../../shared/types';

export interface ResolvedTimestamp {
  rawTimestampText: string;
  resolvedTimestampIso: string | null;
  resolvedDate: string | null; // YYYY-MM-DD in observation timezone
  timezoneOffset: string;
  confidence: TimestampConfidence;
}

const WEEKDAY_MAP: Record<string, number> = {
  sun: 0,
  sunday: 0,
  pazar: 0,
  paz: 0,
  mon: 1,
  monday: 1,
  pazartesi: 1,
  pzt: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  salı: 2,
  sali: 2,
  sal: 2,
  wed: 3,
  wednesday: 3,
  çarşamba: 3,
  carsamba: 3,
  çar: 3,
  car: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  perşembe: 4,
  persembe: 4,
  per: 4,
  fri: 5,
  friday: 5,
  cuma: 5,
  cum: 5,
  sat: 6,
  saturday: 6,
  cumartesi: 6,
  cmt: 6
};

const MONTH_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  oca: 1,
  ocak: 1,
  feb: 2,
  february: 2,
  şub: 2,
  sub: 2,
  şubat: 2,
  subat: 2,
  mar: 3,
  march: 3,
  mart: 3,
  apr: 4,
  april: 4,
  nis: 4,
  nisan: 4,
  may: 5,
  mayıs: 5,
  mayis: 5,
  jun: 6,
  june: 6,
  haz: 6,
  haziran: 6,
  jul: 7,
  july: 7,
  tem: 7,
  temmuz: 7,
  aug: 8,
  august: 8,
  ağu: 8,
  agu: 8,
  ağustos: 8,
  agustos: 8,
  sep: 9,
  sept: 9,
  september: 9,
  eyl: 9,
  eylül: 9,
  eylul: 9,
  oct: 10,
  october: 10,
  eki: 10,
  ekim: 10,
  nov: 11,
  november: 11,
  kas: 11,
  kasım: 11,
  kasim: 11,
  dec: 12,
  december: 12,
  ara: 12,
  aralık: 12,
  aralik: 12
};

export function getLocalTimezoneOffsetString(date: Date = new Date()): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/**
 * Formats a Date or ISO string into local timezone ISO string (YYYY-MM-DDTHH:mm:ss+03:00)
 * so that substr(iso, 1, 10) always reflects the local calendar date.
 */
export function toLocalIsoString(input: Date | string | number = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  const validDate = Number.isNaN(d.getTime()) ? new Date() : d;
  const tzOffset = getLocalTimezoneOffsetString(validDate);
  const offsetMin = parseOffsetMinutes(tzOffset);
  const comp = toLocalComponents(validDate.getTime(), offsetMin);
  return formatIsoWithOffset(
    comp.year,
    comp.month,
    comp.day,
    comp.hour,
    comp.minute,
    comp.second,
    tzOffset
  ).iso;
}

export function getTodayLocalDate(now: Date = new Date()): string {
  return toLocalIsoString(now).slice(0, 10);
}

export function extractTimezoneOffset(isoString: string): string {
  const m = isoString.match(/([+-]\d{2}:\d{2}|Z)$/);
  if (!m || m[1] === 'Z') {
    return getLocalTimezoneOffsetString();
  }
  return m[1];
}

function parseOffsetMinutes(tzOffset: string): number {
  const m = tzOffset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 180; // Default +03:00
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

function toLocalComponents(utcMs: number, offsetMinutes: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
} {
  const shifted = new Date(utcMs + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    dayOfWeek: shifted.getUTCDay()
  };
}

function formatIsoWithOffset(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tzOffset: string
): { iso: string; dateOnly: string } {
  const y = String(year).padStart(4, '0');
  const mo = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  const h = String(hour).padStart(2, '0');
  const mi = String(minute).padStart(2, '0');
  const s = String(second).padStart(2, '0');
  const dateOnly = `${y}-${mo}-${d}`;
  return {
    iso: `${dateOnly}T${h}:${mi}:${s}${tzOffset}`,
    dateOnly
  };
}

function parseTimeToken(text: string): { hour: number; minute: number } | null {
  const m = text.match(/\b(\d{1,2}):(\d{2})(?:\s*(AM|PM))?\b/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3]?.toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function parseExplicitOrMonthDayDate(
  combined: string,
  obsYear: number,
  obsMonth: number,
  obsDay: number
): { year: number; month: number; day: number; isExactYear: boolean } | null {
  // 1. YYYY-MM-DD
  const isoMatch = combined.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    return {
      year: parseInt(isoMatch[1], 10),
      month: parseInt(isoMatch[2], 10),
      day: parseInt(isoMatch[3], 10),
      isExactYear: true
    };
  }

  // 2. DD.MM.YYYY or DD/MM/YYYY
  const dmyMatch = combined.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
  if (dmyMatch) {
    return {
      year: parseInt(dmyMatch[3], 10),
      month: parseInt(dmyMatch[2], 10),
      day: parseInt(dmyMatch[1], 10),
      isExactYear: true
    };
  }

  // Strip time tokens (HH:MM) before scanning for month+day numbers
  const withoutTime = combined.replace(/\b\d{1,2}:\d{2}(?:\s*(?:AM|PM))?\b/gi, ' ');

  // 3. MonthName Day [, Year] (e.g., "Sep 1", "Sep 28, 16:20", "Oct 6, 2026")
  const monthFirstRegex = /\b([a-zA-ZçğıöşüÇĞİÖŞÜ]{3,10})\.?\s+(\d{1,2})(?:[,\s]+(\d{4}))?\b/g;
  let m: RegExpExecArray | null;
  while ((m = monthFirstRegex.exec(withoutTime)) !== null) {
    const monthKey = m[1].toLowerCase();
    const month = MONTH_MAP[monthKey];
    const day = parseInt(m[2], 10);
    if (month && day >= 1 && day <= 31) {
      let year = m[3] ? parseInt(m[3], 10) : obsYear;
      if (!m[3] && (month > obsMonth || (month === obsMonth && day > obsDay + 1))) {
        year = obsYear - 1;
      }
      return { year, month, day, isExactYear: Boolean(m[3]) };
    }
  }

  // 4. Day MonthName [Year] (e.g., "1 Eyl", "28 Eylül 2026", "6 Oct")
  const dayFirstRegex = /\b(\d{1,2})\s+([a-zA-ZçğıöşüÇĞİÖŞÜ]{3,10})\.?(?:[,\s]+(\d{4}))?\b/g;
  while ((m = dayFirstRegex.exec(withoutTime)) !== null) {
    const day = parseInt(m[1], 10);
    const monthKey = m[2].toLowerCase();
    const month = MONTH_MAP[monthKey];
    if (month && day >= 1 && day <= 31) {
      let year = m[3] ? parseInt(m[3], 10) : obsYear;
      if (!m[3] && (month > obsMonth || (month === obsMonth && day > obsDay + 1))) {
        year = obsYear - 1;
      }
      return { year, month, day, isExactYear: Boolean(m[3]) };
    }
  }

  return null;
}

/**
 * Resolves Zoom relative date/time strings ("Today", "Yesterday", "Wed", "Wed 11:55", "Sep 1, 09:50", "Oct 6, 15:09", "16:25")
 * against the observation time without fabricating certainty for ambiguous values.
 * Always preserves the original expression in rawTimestampText.
 */
export function resolveZoomTimestamp(
  dateGroup: string | null | undefined,
  visibleTimestamp: string | null | undefined,
  capturedAtIso: string
): ResolvedTimestamp {
  const dg = (dateGroup ?? '').trim();
  const vt = (visibleTimestamp ?? '').trim();

  let rawTimestampText = '';
  if (dg && vt) {
    if (vt.toLowerCase().startsWith(dg.toLowerCase())) {
      rawTimestampText = vt;
    } else {
      rawTimestampText = `${dg} ${vt}`;
    }
  } else {
    rawTimestampText = vt || dg || 'Bilinmiyor';
  }

  const tzOffset = extractTimezoneOffset(capturedAtIso);
  const offsetMinutes = parseOffsetMinutes(tzOffset);
  const capturedMs = Date.parse(capturedAtIso);
  const baseMs = Number.isNaN(capturedMs) ? Date.now() : capturedMs;
  const obs = toLocalComponents(baseMs, offsetMinutes);

  const combined = `${dg} ${vt}`.trim();
  const timePart = parseTimeToken(vt) ?? parseTimeToken(dg);
  const fallbackHour = timePart?.hour ?? 0;
  const fallbackMinute = timePart?.minute ?? 0;

  // 1. Check explicit ISO, DD.MM.YYYY, or Month+Day ("Sep 1, 09:50", "Oct 6, 15:09", "28 Eyl")
  const parsedCalendarDate = parseExplicitOrMonthDayDate(combined, obs.year, obs.month, obs.day);
  if (parsedCalendarDate) {
    const formatted = formatIsoWithOffset(
      parsedCalendarDate.year,
      parsedCalendarDate.month,
      parsedCalendarDate.day,
      fallbackHour,
      fallbackMinute,
      0,
      tzOffset
    );
    return {
      rawTimestampText,
      resolvedTimestampIso: formatted.iso,
      resolvedDate: formatted.dateOnly,
      timezoneOffset: tzOffset,
      confidence: parsedCalendarDate.isExactYear && timePart ? 'exact' : 'resolved_relative'
    };
  }

  // 2. Determine day offset relative to observation date ("Today", "Yesterday", "Mon..Sun")
  let daysAgo: number | null = null;
  const lowerCombined = combined.toLowerCase();
  const tokens = lowerCombined.replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean);

  if (
    tokens.includes('today') ||
    tokens.includes('bugün') ||
    tokens.includes('bugun') ||
    (!dg && /^\d{1,2}:\d{2}/.test(vt))
  ) {
    daysAgo = 0;
  } else if (tokens.includes('yesterday') || tokens.includes('dün') || tokens.includes('dun')) {
    daysAgo = 1;
  } else {
    for (const tok of tokens) {
      if (tok in WEEKDAY_MAP) {
        const targetDow = WEEKDAY_MAP[tok];
        const diff = (obs.dayOfWeek - targetDow + 7) % 7;
        daysAgo = diff;
        break;
      }
    }
  }

  // If a relative day ("Today", "Yesterday", "Thu", etc.) was identified:
  // If timePart is present, confidence is 'resolved_relative'.
  // If timePart is missing (e.g. a call card or image with only dateGroup="Yesterday"),
  // we still resolve the date accurately so it is associated with that date, while marking confidence 'ambiguous' if dg was just "Today" with no time.
  if (daysAgo !== null && (timePart !== null || (dg && !tokens.includes('today')))) {
    const targetDayMs = baseMs - daysAgo * 86_400_000;
    const targetComp = toLocalComponents(targetDayMs, offsetMinutes);

    const formatted = formatIsoWithOffset(
      targetComp.year,
      targetComp.month,
      targetComp.day,
      fallbackHour,
      fallbackMinute,
      0,
      tzOffset
    );
    return {
      rawTimestampText,
      resolvedTimestampIso: formatted.iso,
      resolvedDate: formatted.dateOnly,
      timezoneOffset: tzOffset,
      confidence: timePart !== null ? 'resolved_relative' : 'ambiguous'
    };
  }

  // Ambiguous: neither calendar date nor relative date+time could be reliably determined
  return {
    rawTimestampText,
    resolvedTimestampIso: null,
    resolvedDate: null,
    timezoneOffset: tzOffset,
    confidence: 'ambiguous'
  };
}
