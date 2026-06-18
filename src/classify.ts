// src/classify.ts
// 사용자(고객/직원/협력사) 분류 룰.
//
// 직원: 이메일 @malgnsoft.com OR tb_user.company = '맑은소프트'
// 협력사: tb_user.name 또는 tb_user.company가 PARTNER_WHITELIST 일치
// 그 외: 고객
// 우선순위: staff > partner > customer (직원 판별이 가장 강함)

export type UserKind = "staff" | "partner" | "customer";

// 직원 회사명 (정확 일치, trim).
export const STAFF_COMPANY = "맑은소프트";

// 협력사 회사·이름 화이트리스트 — 운영팀 합의 후 확장.
// (향후 hp_partner_company 테이블로 이관 가능)
export const PARTNER_WHITELIST = new Set<string>([
  "플로즈",
  "옐로우윈",
  "온케어",  // 송한나 등 — 회사명 매칭
  "송한나",  // 안전망: 회사명 컬럼이 비어있어도 이름으로 매칭
]);

function norm(s: unknown): string {
  return String(s ?? "").trim();
}

export function isStaffEmail(email: unknown): boolean {
  return /@malgnsoft\.com$/i.test(String(email ?? ""));
}

export function isStaff(u: { email?: unknown; company?: unknown } | null | undefined): boolean {
  if (!u) return false;
  if (isStaffEmail((u as any).email)) return true;
  if (norm((u as any).company) === STAFF_COMPANY) return true;
  return false;
}

export function isPartner(u: { name?: unknown; company?: unknown } | null | undefined): boolean {
  if (!u) return false;
  const name = norm((u as any).name);
  const company = norm((u as any).company);
  return (name && PARTNER_WHITELIST.has(name)) || (company && PARTNER_WHITELIST.has(company));
}

export function classifyUser(u: { email?: unknown; name?: unknown; company?: unknown }): UserKind {
  if (isStaff(u)) return "staff";
  if (isPartner(u)) return "partner";
  return "customer";
}

// ── PMS 수집(harvest) 헬퍼 ──────────────────────────────
// 정본: malgn-helper-mng/docs/PMS-INQUIRY-HARVEST.md §3-1(그룹→서비스 매핑) · §5-3(안내글/Q&A 분기)
// 다음 harvest 단계(스캔·배정)에서 쓰는 순수 함수. DB/네트워크 의존 없음.

/**
 * 그룹명 정규화 — 전각 괄호→반각, 연속 공백 1개로, trim.
 * PMS 그룹명은 운영자가 수기 입력하므로 공백/괄호 변형을 흡수한다(§3-2).
 */
function normGroupName(name: unknown): string {
  return String(name ?? "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * PMS `tb_project_group.name` → `hp_service.slug` 결정적 매핑 (HARVEST §3-1, A 규칙).
 * 7서비스: ott / general / global / public / maintenance / refund / standalone.
 * 미매핑(완료/진행/파트너·사내 게시판 등)은 null → 자동 배정 금지·보류(§3-3).
 *
 * ⚠ 문서 §3-1 "실측 DB 그룹명"이 정본. 사용자 지시 매핑 키와 실측이 다른 경우 모두 받아들이도록
 *   동의어(예: 글로벌LMS/글로벌이러닝, 맑은이러닝(오픈전) 괄호 변형)를 함께 수용한다.
 */
const GROUP_SERVICE_MAP: Record<string, string> = {
  // ott
  "OTT 서비스": "ott",
  "OTT서비스": "ott",
  // general (범용) — 맑은이러닝 / 오픈전 / 종료
  "맑은이러닝 서비스": "general",
  "맑은이러닝 서비스(오픈전)": "general",
  "맑은이러닝 종료": "general",
  // global — 실측 글로벌LMS, 문서 표기 글로벌이러닝 동의어 수용
  "글로벌LMS 서비스": "global",
  "글로벌이러닝 서비스": "global",
  "글로벌이러닝": "global",
  // public
  "공공클라우드 서비스": "public",
  // maintenance
  "유지보수 프로젝트": "maintenance",
  // refund
  "환급과정 유지보수": "refund",
  // standalone
  "독립LMS 서비스": "standalone",
};

export function groupNameToServiceSlug(name: unknown): string | null {
  const key = normGroupName(name);
  if (!key) return null;
  return GROUP_SERVICE_MAP[key] ?? null;
}

/**
 * 안내글 후보 판정 (HARVEST §5-3, C 규칙).
 * staff(직원) 작성 + 게시글의 첫 글이면 안내글(공지·정책 안내) 트랙.
 * 그 외(고객/협력사 작성, 또는 첫 글 아님)는 Q&A 트랙.
 * isStaff 판정은 호출부가 `isStaff(...)`(classify.ts) 결과를 넘긴다.
 */
export function isAnnounceCandidate(
  _post: unknown,
  isStaffAuthor: boolean,
  isFirstPost: boolean,
): boolean {
  return isStaffAuthor === true && isFirstPost === true;
}
