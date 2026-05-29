// src/classify.ts
// 사용자(고객/직원/협력사) 분류 룰.
//
// 직원: 이메일 @malgnsoft.com
// 협력사: tb_user.name 또는 tb_user.company가 화이트리스트에 일치 (case·whitespace 무시)
// 그 외: 고객

export type UserKind = "staff" | "partner" | "customer";

// 협력사 회사·이름 화이트리스트 — 운영팀 합의 후 확장.
// (향후 hp_partner_company 테이블로 이관 가능)
export const PARTNER_WHITELIST = new Set<string>([
  "플로즈",
]);

function norm(s: unknown): string {
  return String(s ?? "").trim();
}

export function isStaffEmail(email: unknown): boolean {
  return /@malgnsoft\.com$/i.test(String(email ?? ""));
}

export function isPartner(u: { name?: unknown; company?: unknown } | null | undefined): boolean {
  if (!u) return false;
  const name = norm((u as any).name);
  const company = norm((u as any).company);
  return (name && PARTNER_WHITELIST.has(name)) || (company && PARTNER_WHITELIST.has(company));
}

export function classifyUser(u: { email?: unknown; name?: unknown; company?: unknown }): UserKind {
  if (isStaffEmail(u.email)) return "staff";
  if (isPartner(u)) return "partner";
  return "customer";
}
