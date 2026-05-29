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
