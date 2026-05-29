// src/business-hours.ts
// 영업시간(09:00~17:00 KST, 평일, 공휴일 제외) 기준 분 단위 차이 계산.
// 공휴일은 하드코딩 — 매년 1월 갱신 (또는 향후 hp_holiday 테이블로 이관).

export const BUSINESS_START_HOUR = 9;
export const BUSINESS_END_HOUR = 17;
export const BUSINESS_HOURS_PER_DAY = BUSINESS_END_HOUR - BUSINESS_START_HOUR; // 8

// 한국 법정 공휴일 + 임시공휴일. 'YYYY-MM-DD' (KST).
export const HOLIDAYS_KR = new Set<string>([
  // 2024
  "2024-01-01",
  "2024-02-09", "2024-02-10", "2024-02-11", "2024-02-12",
  "2024-03-01",
  "2024-04-10",
  "2024-05-05", "2024-05-06",
  "2024-05-15",
  "2024-06-06",
  "2024-08-15",
  "2024-09-16", "2024-09-17", "2024-09-18",
  "2024-10-01",
  "2024-10-03",
  "2024-10-09",
  "2024-12-25",
  // 2025
  "2025-01-01",
  "2025-01-28", "2025-01-29", "2025-01-30",
  "2025-03-01", "2025-03-03",
  "2025-05-05", "2025-05-06",
  "2025-06-06",
  "2025-08-15",
  "2025-10-03",
  "2025-10-06", "2025-10-07", "2025-10-08",
  "2025-10-09",
  "2025-12-25",
  // 2026
  "2026-01-01",
  "2026-02-16", "2026-02-17", "2026-02-18",
  "2026-03-01", "2026-03-02",
  "2026-05-05",
  "2026-05-25",
  "2026-06-06",
  "2026-08-15",
  "2026-09-24", "2026-09-25", "2026-09-26",
  "2026-10-03",
  "2026-10-09",
  "2026-12-25",
]);

// 'YYYYMMDDHHMMSS' (KST 가정) → UTC ms
export function parseKst14ToMs(s: string): number | null {
  if (!s || s.length !== 14) return null;
  const y = +s.slice(0, 4);
  const mo = +s.slice(4, 6) - 1;
  const d = +s.slice(6, 8);
  const h = +s.slice(8, 10);
  const mi = +s.slice(10, 12);
  const se = +s.slice(12, 14);
  if ([y, mo, d, h, mi, se].some(Number.isNaN)) return null;
  // KST=UTC+9 → UTC = KST - 9h
  return Date.UTC(y, mo, d, h - 9, mi, se);
}

// 두 UTC ms 사이의 영업시간 분 (KST 09~17, 평일, 공휴일 제외).
export function businessMinutesBetween(
  startMs: number,
  endMs: number,
  holidays: Set<string> = HOLIDAYS_KR,
): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;

  // 모든 시각을 +9h shift → UTC representation이 곧 KST의 그 시각.
  const KST_OFFSET = 9 * 3600 * 1000;
  const shiftedStart = startMs + KST_OFFSET;
  const shiftedEnd = endMs + KST_OFFSET;

  // 첫째 날 00:00 KST (shifted form)
  let cursor = Math.floor(shiftedStart / 86400000) * 86400000;

  let total = 0;
  // 최대 1년 (안전장치)
  let guard = 0;
  while (cursor < shiftedEnd && guard < 400) {
    guard++;
    const d = new Date(cursor);
    const dow = d.getUTCDay(); // 0=일, 6=토 (KST 기준)
    const dayKey =
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const isBiz = dow !== 0 && dow !== 6 && !holidays.has(dayKey);
    if (isBiz) {
      const dayStart = cursor + BUSINESS_START_HOUR * 3600 * 1000;
      const dayEnd = cursor + BUSINESS_END_HOUR * 3600 * 1000;
      const segStart = Math.max(shiftedStart, dayStart);
      const segEnd = Math.min(shiftedEnd, dayEnd);
      if (segEnd > segStart) {
        total += (segEnd - segStart) / 60000;
      }
    }
    cursor += 86400000;
  }
  return total;
}

// 분 → 표기 (영업시간 단위 기준 '8h당 1일')
export function formatBusinessFrt(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < BUSINESS_HOURS_PER_DAY) return `${Math.round(hours)}h`;
  // 8h = 영업일 1일
  const days = hours / BUSINESS_HOURS_PER_DAY;
  return `${days.toFixed(1)}d`;
}
