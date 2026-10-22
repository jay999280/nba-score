/**
 * Formatting helpers shared by the server (status composition) and the client
 * (local-time rendering). All of them are pure.
 *
 * The interface is Chinese, and times are always rendered in the device's own
 * zone — nothing here may hard code an offset (PRD §28).
 */

const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
});

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  weekday: "short",
});

const WEEKDAY_LONG_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  weekday: "long",
});

/** "07:30" in the device zone. */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : TIME_FORMATTER.format(date);
}

/** "10月6日" in the device zone. */
export function formatCompactDate(date: Date): string {
  return DATE_FORMATTER.format(date);
}

/** "周二" in the device zone. */
export function formatWeekday(date: Date): string {
  return WEEKDAY_FORMATTER.format(date);
}

/** "星期二" — used where there is room for it. */
export function formatWeekdayLong(date: Date): string {
  return WEEKDAY_LONG_FORMATTER.format(date);
}

/**
 * `PT06M21.00S` → `6:21`, `PT00M04.30S` → `0:04`.
 * Returns null when the payload carries no usable clock.
 */
export function parseClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const match = /^PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso.trim());
  if (!match) return null;
  const minutes = Number(match[1] ?? 0);
  const seconds = Math.floor(Number(match[2] ?? 0));
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** `PT32M15.00S` → `32:15`, empty minutes → "—". */
export function parseMinutes(iso: string | null | undefined): string {
  if (!iso) return "—";
  const match = /^PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso.trim());
  if (!match) return "—";
  const minutes = Number(match[1] ?? 0);
  const seconds = Math.floor(Number(match[2] ?? 0));
  if (minutes === 0 && seconds === 0) return "—";
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 1 → "第1节", 5 → "加时", 6 → "加时2". */
export function periodLabel(period: number, regulationPeriods = 4): string {
  if (period <= 0) return "";
  if (period <= regulationPeriods) return `第${period}节`;
  const overtime = period - regulationPeriods;
  return overtime === 1 ? "加时" : `加时${overtime}`;
}

/**
 * Parse the NBA feeds' own `meta.time`.
 *
 * Upstream writes `"2026-10-10 01:14:25.1425"`: a space instead of `T`, no
 * zone marker, and the value *is* UTC. `Date.parse` reads that form as local
 * time, which on this device silently moved every source timestamp by eight
 * hours — and a source time that is wrong by eight hours cannot support any
 * "this score is stale" claim. The space form is therefore assembled
 * explicitly with `Date.UTC`. A value that already carries `T` (upstream could
 * change format) is handed to `Date.parse` unchanged.
 *
 * Returns null for anything unusable; never throws.
 */
export function parseUpstreamTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  if (raw.includes("T")) {
    const iso = new Date(raw);
    return Number.isNaN(iso.getTime()) ? null : iso;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // `.1425` is 142.5 ms upstream; milliseconds are the finest resolution a
  // Date can hold, so the fraction is truncated rather than rounded.
  const milliseconds = fractionText ? Number(fractionText.slice(0, 3).padEnd(3, "0")) : 0;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds));

  // Reject a day that rolled over (2026-02-31 → March 3) instead of pretending.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/** Local calendar key, `YYYY-MM-DD`. */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parse `YYYY-MM-DD` into a local Date at midnight. */
export function parseLocalDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0);
}

/** The `[from, to)` ISO window covering one local calendar day. */
export function localDayWindow(key: string): { from: string; to: string } {
  const start = parseLocalDateKey(key);
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 1,
    0,
    0,
    0,
    0,
  );
  return { from: start.toISOString(), to: end.toISOString() };
}

/** 0.482 → "48.2" (percentages arrive as fractions). */
export function formatPercentage(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return (value * 100).toFixed(1);
}

/** `MADE-ATTEMPTED`, tolerating missing values. */
export function formatShooting(made: number, attempted: number): string {
  return `${made ?? 0}-${attempted ?? 0}`;
}

/** "+7" / "-3" / "0" */
export function formatPlusMinus(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value > 0) return `+${value}`;
  return String(value);
}

/** "10:42" — used by the "更新于 10:42" note (PRD §33). */
export function formatUpdatedAt(date: Date): string {
  return TIME_FORMATTER.format(date);
}

const SOURCE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * The upstream's own data time, as a label.
 *
 * Always carries the date: a line reading "更新于 01:14" under a payload that is
 * a day old is the exact confusion this label exists to remove. Rendered in the
 * device's zone, like every other time in the app.
 */
export function formatSourceAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return null;
  return SOURCE_FORMATTER.format(time).replaceAll("/", "-");
}

/** Coarse age: "刚刚" / "42分钟前" / "5小时前" / "2天前" / "约1个月前". */
export function formatAge(value: Date | string | number, now = Date.now()): string | null {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return `约${Math.max(1, Math.floor(days / 30))}个月前`;
}

/**
 * Countdown to tip-off, device-local: "即将开始", "还有42分钟",
 * "还有3小时12分", "还有3小时". Beyond 24h there is no countdown — callers
 * fall back to a weekday + time label instead.
 */
export function formatCountdown(startISO: string, nowMs: number): string | null {
  const startMs = Date.parse(startISO);
  if (Number.isNaN(startMs)) return null;
  const diffMs = startMs - nowMs;
  if (diffMs <= 0) return "即将开始";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "即将开始";
  if (minutes < 60) return `还有${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return null;
  const rest = minutes % 60;
  return rest === 0 ? `还有${hours}小时` : `还有${hours}小时${rest}分`;
}

/** "明天 19:30" / "周三 19:30" — for tip-offs beyond the countdown range. */
export function formatFutureTipoff(startISO: string, now: Date): string {
  const start = new Date(startISO);
  if (Number.isNaN(start.getTime())) return "";
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const dayAfter = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  const dayLabel =
    start < dayAfter && start >= tomorrow ? "明天" : formatWeekday(start);
  return `${dayLabel} ${formatLocalTime(startISO)}`;
}
