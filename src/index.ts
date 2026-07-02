import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { createConnection } from "mysql2/promise";
import { openapiSpec, docHtml } from "./openapi";
import { callOpenAiJson, callWorkersAi } from "./llm";
import { sign as jwtSign, verify as jwtVerify } from "hono/jwt";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  parseKst14ToMs,
  businessMinutesBetween,
  formatBusinessFrt,
  BUSINESS_START_HOUR,
  BUSINESS_END_HOUR,
} from "./business-hours";
import { classifyUser, isPartner, groupNameToServiceSlug, isAnnounceCandidate } from "./classify";

type Bindings = {
  R2: R2Bucket;
  HYPERDRIVE: Hyperdrive;
  AI: Ai;
  VECTORIZE: VectorizeIndex; // 학습 자료 청크 임베딩 인덱스(malgn-helper-material-vectors, 1024-dim cosine)
  VECTORIZE_SA: VectorizeIndex; // 표준답변 임베딩 인덱스(malgn-helper-sa-vectors, 1024-dim cosine). SA 1건=벡터 1개. VECTORIZE(자료)와 별개.
  AI_GATEWAY_URL: string;
  AI_GATEWAY_TOKEN?: string;
  OPENAI_API_KEY: string;
  LLM_MODEL_DEFAULT: string;
  LLM_MODEL_PREMIUM: string;
  JWT_SECRET: string; // wrangler secret — admin JWT 서명
  PMS_ASSET_BASE?: string; // vars — PMS 자산(/data/..) 절대화 base. 미설정 시 https://ppm.malgn.co.kr
  PMS_SERVICE_TOKEN?: string; // wrangler secret — PMS 프록시 공유 시크릿(미설정 시 가드 통과)
  SERVICE_TOKEN_ENFORCE?: string; // vars "1"이면 secret 설정+토큰 불일치 시 401
  RL_LLM?: RateLimit; // Cloudflare Rate Limiting binding (LLM generate)
};

/** Cloudflare Rate Limiting binding 형상 (workers-types 미포함 시 대비 인라인). */
interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

const app = new Hono<{
  Bindings: Bindings;
  Variables: { session: SessionPayload };
}>();

const DEFAULT_PMS_ASSET_BASE = "https://ppm.malgn.co.kr";

// PMS 자산(/data/..) 상대경로 1건 → 절대 URL. 이미 절대(http) 면 그대로.
function pmsAbsoluteUrl(u: string, base: string): string {
  if (/^https?:\/\//i.test(u)) return u;
  const cleaned = u.replace(/^(\.\.\/|\.\/)+/, "").replace(/^\/+/, "");
  return `${base.replace(/\/+$/, "")}/${cleaned}`;
}

// 본문(마크다운 ![](..)/링크 + HTML src/href) 내 PMS 자산 이미지 경로를 모두 절대 URL로 정규화.
// 표준답변 저장 시 정본을 도메인 포함 절대경로로 고정 → 챗봇·admin 등 다른 도메인에서도 안 깨짐.
function absolutizePmsAssets(text: string, base: string): string {
  if (!text) return text;
  return text
    .replace(
      /(\]\(\s*)((?:\.\.\/|\.\/)*\/?data\/[^)\s]+)/g,
      (_m, pre: string, p: string) => pre + pmsAbsoluteUrl(p, base),
    )
    .replace(
      /((?:src|href)=)(["'])((?:\.\.\/|\.\/)*\/?data\/[^"']+)\2/gi,
      (_m, attr: string, q: string, p: string) => `${attr}${q}${pmsAbsoluteUrl(p, base)}${q}`,
    );
}

// HTML escape — paragraphsToHtml 저장 래핑용(텍스트를 <p>로 감싸기 전 이스케이프).
function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 블록 경계를 보존하는 HTML→텍스트 추출. </p></div></li></h1~6>·<br> → 줄바꿈.
// 공백/탭만 collapse(줄바꿈 보존), 줄별 trim, 연속 빈 줄 1줄로 축소.
// stripHtml(한 줄 평문)과 달리 단락·줄바꿈을 유지 → 마스킹 입력/최종 저장 본문에 사용.
function htmlToParagraphs(html: string): string {
  let s = String(html ?? "");
  // 블록 종료 태그·줄바꿈 태그 → \n
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/\s*(p|div|li|h[1-6]|tr|blockquote|pre)\s*>/gi, "\n");
  // 리스트/표 시작도 줄 경계로(가독성)
  s = s.replace(/<\s*(li|tr)\b[^>]*>/gi, "\n");
  // 나머지 태그 제거
  s = s.replace(/<[^>]+>/g, "");
  // HTML 엔티티 일부 복원(원문이 escape 돼 있을 수 있음)
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  // 줄 단위 처리: 공백/탭만 collapse(줄바꿈 보존), 줄별 trim
  const lines = s.split("\n").map((ln) => ln.replace(/[ \t ]+/g, " ").trim());
  // 연속 빈 줄 → 1줄
  const out: string[] = [];
  let prevBlank = false;
  for (const ln of lines) {
    const blank = ln.length === 0;
    if (blank && prevBlank) continue;
    out.push(ln);
    prevBlank = blank;
  }
  return out.join("\n").trim();
}

// 단락 보존 텍스트 → 저장용 HTML. 비어있지 않은 각 줄을 <p>…</p>(escape 후)로 래핑.
// 다른 HTML 수집분과 일관 + admin TinyMCE에서 단락 표시.
function paragraphsToHtml(text: string): string {
  const lines = String(text ?? "").split("\n");
  const parts: string[] = [];
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    parts.push(`<p>${escapeHtml(ln)}</p>`);
  }
  return parts.join("");
}

// ── 이미지/링크 자산 보존 토큰화 (수집 마스킹 경로용) ──────────────────────────
// 배경: htmlToParagraphs 가 <img> 포함 모든 태그를 제거 → V2 마스킹 경로에서 이미지 0% 소실.
// 해결: 텍스트로 환원하기 전에 <img>·<a>·<figure>·<figcaption> 을 플레이스홀더 토큰(⟦HPASSET_n⟧)으로 치환 →
//   텍스트만 태그 제거(htmlToParagraphs) → (마스킹 LLM 은 토큰을 그대로 보존) →
//   복원 단계서 토큰을 원본 자산 HTML 로 되돌리고 absolutizePmsAssets 로 절대화.
// 토큰은 영숫자·기호(<,> 없음)라 htmlToParagraphs 의 태그 제거·줄처리·escapeHtml 를 무사 통과한다.
// 마스킹 LLM 입력 텍스트엔 토큰만 노출(이미지 src URL 미노출 → 토큰=텍스트, PII 영향 없음).
const HP_ASSET_TOKEN_RE = /⟦HPASSET_(\d+)⟧/g;

type AssetTokenized = { text: string; tokens: string[] };

// HTML 에서 <img>(self-closing 포함)·<a>…</a>·<figure>…</figure>·<figcaption>…</figcaption> 을
// 토큰으로 치환하고, 토큰별 원본 HTML 배열을 함께 반환. 그 뒤 htmlToParagraphs 로 텍스트화.
//   - <a>/<figure>/<figcaption> 은 컨테이너 — 내부 텍스트도 토큰에 흡수(링크 라벨·캡션 보존).
//   - 중첩(figure>img) 은 바깥(figure)을 먼저 매칭해 통째 토큰화(내부 img 토큰화 생략) → 원본 그대로 보존.
function tokenizeAssets(html: string): AssetTokenized {
  let s = String(html ?? "");
  const tokens: string[] = [];
  const push = (frag: string): string => {
    const i = tokens.length;
    tokens.push(frag);
    return `⟦HPASSET_${i}⟧`;
  };
  // 1) figure(캡션·이미지 래퍼) 통째 — 내부 img/figcaption 포함.
  s = s.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, (m) => push(m));
  // 2) 남은 figcaption 단독.
  s = s.replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, (m) => push(m));
  // 3) 이미지를 감싼 링크(a>img) — 링크째 보존(클릭 시 원본 보기).
  s = s.replace(/<a\b[^>]*>\s*(?:<img\b[^>]*\/?>)\s*<\/a>/gi, (m) => push(m));
  // 4) 단독 img(self-closing 허용).
  s = s.replace(/<img\b[^>]*\/?>/gi, (m) => push(m));
  // 5) 남은 일반 링크 — 텍스트 라벨 포함 통째.
  s = s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (m) => push(m));
  // 토큰을 줄 경계로 분리(앞뒤 \n) → htmlToParagraphs 가 독립 단락으로 처리 → 복원 시 자산이 한 줄에.
  s = s.replace(HP_ASSET_TOKEN_RE, (m) => `\n${m}\n`);
  return { text: htmlToParagraphs(s), tokens };
}

// paragraphsToHtml 산출물(escape 완료) 안의 토큰을 원본 자산 HTML 로 복원.
//   - 토큰만 든 <p>⟦HPASSET_n⟧</p> → 원본 자산 HTML (figure/img/a) 로 통째 교체.
//   - 텍스트 중간 토큰 → 자산 HTML 인라인 삽입.
// 복원은 paragraphsToHtml(escape) 이후에 해야 자산 HTML 의 <,> 가 escape 되지 않는다.
function restoreAssetTokens(html: string, tokens: string[]): string {
  let s = String(html ?? "");
  // 토큰만 든 <p> 래퍼 제거(자산을 단락 래핑하지 않고 그대로).
  s = s.replace(/<p>\s*(⟦HPASSET_\d+⟧)\s*<\/p>/g, "$1");
  s = s.replace(HP_ASSET_TOKEN_RE, (_m, idx: string) => {
    const i = Number(idx);
    return Number.isInteger(i) && i >= 0 && i < tokens.length ? tokens[i] : "";
  });
  return s;
}

// 마스킹된 단락 텍스트(토큰 보존) → 저장 HTML. paragraphsToHtml 래핑 → 토큰 복원 → 자산 절대화.
function paragraphsToHtmlWithAssets(text: string, tokens: string[], assetBase: string): string {
  const wrapped = paragraphsToHtml(text);
  const restored = restoreAssetTokens(wrapped, tokens);
  return absolutizePmsAssets(restored, assetBase);
}

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      // 가족 pages.dev 프로젝트(프로덕션 + <deploy>.* 프리뷰)만 허용 — 임의 *.pages.dev 반사 차단.
      // 허용 대상: malgn-helper(-admin|-pms|-mng).pages.dev. credentials:true 와 결합되는 반사 범위를 좁힌다.
      if (/^https:\/\/([a-z0-9-]+\.)?malgn-helper(-admin|-pms|-mng)?\.pages\.dev$/.test(origin)) return origin;
      if (/\.malgnsoft\.com$/.test(origin)) return origin;
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      return null;
    },
    allowMethods: ["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true, // cookie 기반 인증 (admin)
    maxAge: 600, // 10분 — 룰 변경 시 빠르게 전파
  }),
);

// ── 인증 세션·가드 (admin · tb_user 기반) ────────────────
// 라우트 핸들러는 모듈 로드 시점에 등록되므로(top-down), 가드 const는
// 이를 참조하는 어떤 app.get/post(...)보다 반드시 먼저 선언돼야 한다(TDZ 회피).
const SESSION_COOKIE = "helper_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8h

type SessionPayload = {
  sub: number;        // tb_user.id
  loginId: string;
  name: string;
  email: string;
  company: string;
  level: number;
  iat: number;
  exp: number;
};

// 역할 레벨: agent < developer(5) <= admin(9). roleOf와 정합.
const ROLE_LEVEL = { agent: 1, developer: 5, admin: 9 } as const;

/** 세션 토큰 추출 — Authorization: Bearer 우선, 없으면 helper_session 쿠키(크로스사이트 쿠키 차단 대비). */
function getSessionToken(c: any): string | undefined {
  const auth = c.req.header("Authorization") || c.req.header("authorization");
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return getCookie(c, SESSION_COOKIE);
}

/** helper_session 쿠키/Bearer 토큰의 JWT를 검증하고 c.set("session")에 payload 주입. 실패 시 401. */
const requireAuth: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: { session: SessionPayload };
}> = async (c, next) => {
  const token = getSessionToken(c);
  if (!token) return c.json({ error: "로그인이 필요합니다." }, 401);
  try {
    // sign은 default(HS256) → verify에도 alg 명시 (hono v4 verify는 3번째 인자 필수)
    const payload = (await jwtVerify(token, c.env.JWT_SECRET, "HS256")) as unknown as SessionPayload;
    c.set("session", payload);
    await next();
  } catch {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ error: "세션이 만료되었습니다. 다시 로그인해 주세요." }, 401);
  }
};

/** 최소 권한(level) 가드 — requireAuth 뒤에 체인해서 사용. */
const requireRole = (
  minLevel: number,
): MiddlewareHandler<{
  Bindings: Bindings;
  Variables: { session: SessionPayload };
}> => async (c, next) => {
  const s = c.get("session");
  if (!s) return c.json({ error: "로그인이 필요합니다." }, 401);
  if ((s.level ?? 0) < minLevel) return c.json({ error: "접근 권한이 없습니다." }, 403);
  await next();
};

// ── PMS 서비스 토큰 가드 (보안 백로그 #1) ─────────────────
// 대상: PMS 임베드가 비인증으로 호출하는 6개 라우트(표준답변 주입·usage·LLM generate).
// 전달 경로: PMS는 client-only Nuxt SPA(server/ 없음) → 토큰을 브라우저 번들에 두면 노출.
//   따라서 PMS는 Nitro 서버 라우트 프록시(server/api/*)를 신설하고, 토큰은 PMS 서버 env로만 보관.
//   브라우저 → PMS 서버 프록시 → 이 API(X-Service-Token 헤더).
//
// 점진 전환(prod 회귀 방지):
//   - secret 미설정(env.PMS_SERVICE_TOKEN 부재)  → 통과 (전환 전 현행 동작 유지)
//   - secret 설정 + 헤더 없음/불일치          → SERVICE_TOKEN_ENFORCE !== "1" 이면 통과(관찰),
//                                              "1" 이면 401 (하드 차단)
//   - secret 설정 + 헤더 일치                  → 통과
//   롤아웃 순서: (1) secret put + PMS 프록시 배포 → (2) 일치 로그 확인 → (3) ENFORCE=1.
const SERVICE_TOKEN_HEADER = "x-service-token";

/** 길이 누설 없는 상수시간 문자열 비교. */
const timingSafeEqual = (a: string, b: string): boolean => {
  // 길이 불일치도 가짜 비교로 흡수해 early-return 타이밍 차이를 줄인다.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
};

const requireServiceToken: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: { session: SessionPayload };
}> = async (c, next) => {
  const expected = c.env.PMS_SERVICE_TOKEN;
  // 전환 전: secret 미설정 → 현행 무인증 동작 유지.
  if (!expected) return next();

  const provided = c.req.header(SERVICE_TOKEN_HEADER);
  const ok = typeof provided === "string" && timingSafeEqual(provided, expected);
  if (ok) return next();

  // secret은 설정됐는데 토큰이 없거나 틀림.
  if (c.env.SERVICE_TOKEN_ENFORCE === "1") {
    return c.json({ error: "unauthorized: invalid service token" }, 401);
  }
  // 관찰 모드: 차단하지 않되 헤더로 표시(로그/대시보드에서 미전환 호출 추적).
  c.header("X-Service-Token-Status", provided ? "mismatch" : "missing");
  return next();
};


// ── rate limit (LLM generate 4종 — IP+프로젝트/포스트 키 기준 분당 한도) ──
// Cloudflare Rate Limiting binding 사용(무상태·무료, KV/D1 불필요).
// wrangler.jsonc 의 [[ratelimits]] / unsafe binding 으로 RL_LLM 주입(분당 N회/키).
const rateLimitLlm: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: { session: SessionPayload };
}> = async (c, next) => {
  const rl = c.env.RL_LLM;
  if (!rl) return next(); // 바인딩 미설정 시 통과(점진 적용).
  const ip =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for") ||
    "unknown";
  // 키: route path(파라미터 포함) + IP → 프로젝트/포스트별·IP별 버킷.
  const key = `${c.req.path}|${ip}`;
  const { success } = await rl.limit({ key });
  if (!success) {
    return c.json({ error: "rate limited: too many generate requests" }, 429);
  }
  await next();
};

app.get("/", (c) => c.json({ name: "malgn-helper-api", status: "ok" }));
app.get("/healthz", (c) => c.json({ ok: true }));


// ── API 문서 (Scalar UI + OpenAPI 3.1 JSON) ─────────────
app.get("/doc", (c) => c.html(docHtml));
app.get("/doc/openapi.json", (c) => c.json(openapiSpec));

const WBS_KEY = "wbs/wbs.json";

app.get("/wbs", requireAuth, async (c) => {
  const obj = await c.env.R2.get(WBS_KEY);
  if (!obj) return c.json({ exists: false }, 404);
  const body = await obj.text();
  const etag = obj.httpEtag;
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ETag: etag,
    },
  });
});

// ── DB (Hyperdrive → MySQL) ─────────────────────────────
async function withConn<T>(c: any, fn: (conn: any) => Promise<T>): Promise<T | Response> {
  const hd = c.env.HYPERDRIVE;
  const conn = await createConnection({
    host: hd.host,
    user: hd.user,
    password: hd.password,
    database: hd.database,
    port: hd.port,
    disableEval: true,
    // PMS DB는 KST 기준. mysql2 default('local')는 Worker가 UTC라 9h 어긋남 → 명시.
    timezone: "+09:00",
  });
  try {
    return await fn(conn);
  } catch (e) {
    return c.json({ error: (e as Error).message, stack: (e as Error).stack?.split("\n").slice(0, 5) }, 500);
  } finally {
    c.executionCtx.waitUntil(conn.end());
  }
}

// ── PMS 연동 ─────────────────────────────────────────────
// reg_date가 'YYYYMMDDHHMMSS' varchar(14) (KST). ISO 형식으로 +09:00 명시.
function toIso(s: string | null): string | null {
  if (!s || s.length !== 14) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+09:00`;
}

// 이미지 자산 Vision 분석 + 저장. src_path UNIQUE라 이미 분석된 이미지는 재사용 (usage_count 증가).
async function analyzeAndStoreImage(
  conn: any,
  env: Bindings,
  args: {
    srcPath: string;
    absoluteUrl: string;
    postId: number;
    projectId: number;
    source: "inquiry" | "reply";
  },
): Promise<{ id: number; title: string; description: string; reused: boolean } | null> {
  // 1) 캐시 hit 체크
  const [cachedRows] = await conn.query(
    `SELECT id, title, description FROM hp_image_asset WHERE src_path = ? AND status = 1 LIMIT 1`,
    [args.srcPath],
  );
  const cached = (cachedRows as any[])[0];
  if (cached) {
    await conn.query(
      `UPDATE hp_image_asset SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ?`,
      [cached.id],
    );
    return { id: cached.id, title: cached.title, description: cached.description, reused: true };
  }

  // 2) Vision 분석 — title + description 추출
  try {
    const llm = await callOpenAiJson<{ title: string; description: string }>(env, {
      model: env.LLM_MODEL_PREMIUM,
      system: [
        "이미지의 핵심 내용을 한국어 JSON으로 추출하라.",
        "- title: 10~20자 이내 짧은 화면/이미지 제목 (예: '알림톡 코드 확인 화면', '비즈뿌리오 발신 프로필 등록 폼').",
        "- description: 화면에 보이는 메뉴명·버튼명·필드명·표 내용·상황을 사실 기반 2~3줄로 묘사. 추측 금지.",
        '출력: {"title":"...","description":"..."}',
      ].join("\n"),
      user: "이미지의 title과 description을 작성해 주세요.",
      images: [args.absoluteUrl],
      maxTokens: 600,
      temperature: 0.2,
      timeoutMs: 30_000,
    });
    const title = String(llm.data.title || "").slice(0, 200) || "(제목 없음)";
    const description = String(llm.data.description || "").slice(0, 5000) || "(설명 없음)";
    const [ins] = await conn.query(
      `INSERT INTO hp_image_asset
         (src_path, title, description, first_seen_post_id, first_seen_project_id, source, llm_model)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE usage_count = usage_count + 1, last_used_at = NOW()`,
      [args.srcPath, title, description, args.postId, args.projectId, args.source, llm.model],
    );
    return { id: (ins as any).insertId, title, description, reused: false };
  } catch {
    return null; // 분석 실패 — 흐름은 진행, 다음 번 호출에서 재시도 가능
  }
}
// 프로젝트의 게시글 목록 (검색·필터·페이지네이션). 작성자 분류 칩 포함.
app.get("/pms/projects/:id/posts", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const q = (c.req.query("q") ?? "").trim();
    const filter = c.req.query("filter") ?? ""; // 'unanswered' | 'customer' | ''

    // staff user id 캐시 (이메일 + 회사명)
    const [staffUserRows] = await conn.query(
      `SELECT id FROM tb_user
        WHERE status = 1
          AND (email LIKE '%@malgnsoft.com' OR company = '맑은소프트')`,
    );
    const staffIds = (staffUserRows as any[]).map((r) => Number(r.id));
    const staffIdsSql = staffIds.length > 0 ? staffIds.join(",") : "0";

    const where: string[] = ["p.project_id = ?", "p.status = 1"];
    const params: any[] = [id];
    if (q) {
      where.push("(p.subject LIKE ? OR p.writer LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    if (filter === "customer") {
      where.push(`p.user_id NOT IN (${staffIdsSql})`);
    } else if (filter === "unanswered") {
      where.push(`p.user_id NOT IN (${staffIdsSql})`);
      where.push(`NOT EXISTS (
        SELECT 1 FROM tb_post_comment c
         WHERE c.post_id = p.id AND c.status = 1
           AND c.user_id IN (${staffIdsSql})
      )`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM tb_post p ${whereSql}`,
      params,
    );
    const total = Number((countRows as any[])[0]?.total ?? 0);

    const [rows] = await conn.query(
      `SELECT p.id, p.subject, p.writer, p.reg_date, p.comm_cnt, p.label, p.label_color, p.label_background,
              u.email AS u_email, u.name AS u_name, u.company AS u_company,
              (p.user_id IN (${staffIdsSql})) AS writer_is_staff,
              EXISTS (
                SELECT 1 FROM tb_post_comment c
                 WHERE c.post_id = p.id AND c.status = 1
                   AND c.user_id IN (${staffIdsSql})
              ) AS has_staff_reply
         FROM tb_post p
    LEFT JOIN tb_user u ON u.id = p.user_id
         ${whereSql}
     ORDER BY p.reg_date DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    return c.json({
      total,
      limit,
      offset,
      rows: (rows as any[]).map((r) => {
        const isStaff = Number(r.writer_is_staff) === 1;
        const isPartner = !isStaff && (
          (r.u_name && /^(플로즈|옐로우윈|온케어|송한나)$/.test(String(r.u_name).trim())) ||
          (r.u_company && /^(플로즈|옐로우윈|온케어)$/.test(String(r.u_company).trim()))
        );
        return {
          id: r.id,
          subject: r.subject,
          writer: r.writer,
          writerEmail: r.u_email,
          writerCompany: r.u_company,
          writerKind: isStaff ? "staff" : isPartner ? "partner" : "customer",
          regDate: toIso(r.reg_date),
          commCount: Number(r.comm_cnt ?? 0),
          label: r.label || null,
          labelColor: r.label_color || null,
          labelBackground: r.label_background || null,
          hasStaffReply: Number(r.has_staff_reply) === 1,
          unanswered: !isStaff && Number(r.has_staff_reply) === 0,
        };
      }),
    });
  }),
);

// 프로젝트 단건 메타 (이름·그룹·발주처·상태·기간)
app.get("/pms/projects/:id", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const [rows] = await conn.query(
      `SELECT p.id, p.name, p.description, p.buyer, p.url, p.start_date, p.end_date,
              p.status, p.site_id, p.group_id, p.reg_date,
              g.name AS group_name,
              (SELECT COUNT(*) FROM tb_post WHERE project_id = p.id AND status = 1) AS post_count,
              (SELECT MAX(reg_date) FROM tb_post WHERE project_id = p.id AND status = 1) AS last_activity
         FROM tb_project p
    LEFT JOIN tb_project_group g ON g.id = p.group_id AND g.status = 1
        WHERE p.id = ?`,
      [id],
    );
    const r = (rows as any[])[0];
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({
      id: r.id,
      name: r.name,
      description: r.description,
      buyer: r.buyer,
      url: r.url,
      startDate: r.start_date, // 'YYYYMMDD'
      endDate: r.end_date,
      active: r.status === 1,
      siteId: r.site_id,
      groupId: r.group_id,
      groupName: r.group_name,
      regDate: toIso(r.reg_date),
      postCount: Number(r.post_count ?? 0),
      lastActivity: toIso(r.last_activity),
    });
  }),
);

// 그룹 목록 (셀렉트박스용). site_id 기본 1, 활성만.
app.get("/pms/groups", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const siteParam = c.req.query("siteId");
    const where: string[] = ["g.status = 1"];
    const params: any[] = [];
    if (siteParam !== "all") {
      const sid = siteParam ? parseInt(siteParam, 10) : 1;
      if (Number.isFinite(sid)) {
        where.push("g.site_id = ?");
        params.push(sid);
      }
    }
    const [rows] = await conn.query(
      `SELECT g.id, g.name, g.pid, g.depth, g.sort, g.site_id,
              (SELECT COUNT(*) FROM tb_project p
                WHERE p.group_id = g.id AND p.status = 1 AND p.id > 0
                  AND p.site_id = g.site_id) AS project_count
         FROM tb_project_group g
        WHERE ${where.join(" AND ")}
     ORDER BY g.sort ASC, g.id ASC`,
      params,
    );
    return c.json({
      rows: (rows as any[]).map((r) => ({
        id: Number(r.id),
        name: r.name,
        pid: Number(r.pid ?? 0),
        depth: Number(r.depth ?? 0),
        siteId: Number(r.site_id),
        projectCount: Number(r.project_count ?? 0),
      })),
    });
  }),
);

// 프로젝트 목록 + 간이 통계 (검색·페이지네이션).
app.get("/pms/projects", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const q = (c.req.query("q") ?? "").trim();
    const onlyActive = c.req.query("status") !== "all"; // 기본: 활성만

    const siteParam = c.req.query("siteId");
    const where: string[] = ["p.id > 0"]; // 시스템/임시 row 제외
    const params: any[] = [];
    if (siteParam !== "all") {
      // 기본: site_id = 1 (메인 사이트). ?siteId=all 로 우회, ?siteId=N 으로 특정 사이트.
      const sid = siteParam ? parseInt(siteParam, 10) : 1;
      if (Number.isFinite(sid)) {
        where.push("p.site_id = ?");
        params.push(sid);
      }
    }
    if (onlyActive) where.push("p.status = 1");
    const groupParam = c.req.query("groupId");
    if (groupParam) {
      const gid = parseInt(groupParam, 10);
      if (Number.isFinite(gid)) {
        where.push("p.group_id = ?");
        params.push(gid);
      }
    }
    if (q) {
      where.push("(p.name LIKE ? OR p.buyer LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM tb_project p ${whereSql}`,
      params,
    );
    const total = Number((countRows as any[])[0]?.total ?? 0);

    const [rows] = await conn.query(
      `SELECT p.id, p.name, p.buyer, p.status, p.reg_date, p.group_id,
              g.name AS group_name,
              (SELECT COUNT(*) FROM tb_post WHERE project_id = p.id AND status = 1) AS post_count,
              (SELECT MAX(reg_date) FROM tb_post WHERE project_id = p.id AND status = 1) AS last_activity
         FROM tb_project p
    LEFT JOIN tb_project_group g ON g.id = p.group_id AND g.status = 1
         ${whereSql}
     ORDER BY last_activity DESC, p.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    return c.json({
      total,
      limit,
      offset,
      rows: (rows as any[]).map((r) => ({
        id: r.id,
        name: r.name,
        buyer: r.buyer,
        active: r.status === 1,
        groupId: r.group_id,
        groupName: r.group_name ?? null,
        postCount: Number(r.post_count ?? 0),
        lastActivity: toIso(r.last_activity),
      })),
    });
  }),
);

// ── Briefing 빌더 (GET + POST 공통) ──────────────────────
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 집계 기준:
//   - 누적·핫카테고리·FAQ·Policies → 전체 status=1 문의
//   - 사람·평균FRT·미응답·긴급·알림 → 최근 180일
//   - 사람 0명 → 화면에 "최근 180일 문의 없음" 표시
const RECENT_DAYS = 180;
// reg_date가 varchar(14) 'YYYYMMDDHHMMSS' 포맷이므로 cutoff도 같은 문자열로 비교 (인덱스 활용)
const SINCE_14_SQL = `DATE_FORMAT(DATE_SUB(NOW(), INTERVAL ${RECENT_DAYS} DAY), '%Y%m%d%H%i%s')`;

async function buildBriefingDbOnly(conn: any, id: number, timings?: Record<string, number>): Promise<{ briefing: any; staffIds: number[] } | null> {
    const tick = (label: string, started: number) => {
      if (timings) timings[label] = Date.now() - started;
    };
    let t = Date.now();
    const [projRows] = await conn.query(
      `SELECT id, name, description, buyer, start_date, end_date, status
         FROM tb_project WHERE id = ?`,
      [id],
    );
    tick("project", t);
    const proj = (projRows as any[])[0];
    if (!proj) return null;

    // staff user id 캐시 (이후 모든 쿼리에서 IN/NOT IN으로 사용 — email LIKE 풀스캔 회피)
    t = Date.now();
    const [staffUserRows] = await conn.query(
      `SELECT id FROM tb_user
        WHERE status = 1
          AND (email LIKE '%@malgnsoft.com' OR company = '맑은소프트')`,
    );
    tick("staffIds", t);
    const staffIds = (staffUserRows as any[]).map((r) => Number(r.id));
    const staffIdsSql = staffIds.length > 0 ? staffIds.join(",") : "0"; // 빈 경우 매치 안 되도록 0

    // 멤버: 최근 180일 글 또는 댓글에 참여한 user.
    // 한 쿼리(IN UNION 서브쿼리)가 매우 느렸음 — 3단계로 분리해 각 인덱스를 살린다.
    t = Date.now();
    const [postUserRows] = await conn.query(
      `SELECT DISTINCT user_id FROM tb_post
        WHERE project_id = ? AND status = 1 AND reg_date >= ${SINCE_14_SQL}`,
      [id],
    );
    const [commentUserRows] = await conn.query(
      `SELECT DISTINCT c.user_id FROM tb_post_comment c
         JOIN tb_post p ON p.id = c.post_id
        WHERE p.project_id = ? AND c.status = 1 AND c.reg_date >= ${SINCE_14_SQL}`,
      [id],
    );
    const memberUserIds = Array.from(
      new Set([
        ...(postUserRows as any[]).map((r) => Number(r.user_id)),
        ...(commentUserRows as any[]).map((r) => Number(r.user_id)),
      ]),
    ).filter((n) => Number.isFinite(n) && n > 0);
    const memberRows: any[] = memberUserIds.length > 0 ? ((await conn.query(
      `SELECT u.id, u.name, u.email, u.company, u.rank,
              (u.id IN (${staffIdsSql})) AS is_staff
         FROM tb_user u
        WHERE u.status = 1 AND u.id IN (${memberUserIds.join(",")})`
    ))[0] as any[]) : [];
    tick("members", t);

    // post 통계: 누적 총수(전체) + 180일 / 첫·마지막 활동(전체)
    t = Date.now();
    const [statsRows] = await conn.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN reg_date >= ${SINCE_14_SQL} THEN 1 ELSE 0 END) AS recent_total,
              MIN(reg_date) AS first_post,
              MAX(reg_date) AS last_post
         FROM tb_post WHERE project_id = ? AND status = 1`,
      [id],
    );
    tick("stats", t);
    const stats0 = (statsRows as any[])[0];

    // 라벨 분포 (전체, 상위 6)
    t = Date.now();
    const [labelRows] = await conn.query(
      `SELECT label, COUNT(*) AS cnt
         FROM tb_post
        WHERE project_id = ? AND status = 1 AND label IS NOT NULL AND label != ''
     GROUP BY label
     ORDER BY cnt DESC
        LIMIT 6`,
      [id],
    );

    tick("labels", t);

    // 직원별 응대 건수 — 최근 180일 댓글 (staff user IN)
    t = Date.now();
    const [staffRows] = await conn.query(
      `SELECT u.name, u.rank, COUNT(c.id) AS cnt
         FROM tb_post_comment c
         JOIN tb_user u ON u.id = c.user_id
         JOIN tb_post p ON p.id = c.post_id
        WHERE p.project_id = ? AND c.status = 1
          AND c.user_id IN (${staffIdsSql})
          AND c.reg_date >= ${SINCE_14_SQL}
     GROUP BY u.id, u.name, u.rank
     ORDER BY cnt DESC
        LIMIT 10`,
      [id],
    );

    tick("staffRanking", t);

    // 미응답: 최근 180일 글 중 직원 댓글 없는 고객 글 (staff IN, 인덱스 효율)
    t = Date.now();
    const [unansweredRows] = await conn.query(
      `SELECT COUNT(*) AS cnt
         FROM tb_post p
        WHERE p.project_id = ? AND p.status = 1
          AND p.reg_date >= ${SINCE_14_SQL}
          AND p.user_id NOT IN (${staffIdsSql})
          AND NOT EXISTS (
            SELECT 1 FROM tb_post_comment c
             WHERE c.post_id = p.id AND c.status = 1
               AND c.user_id IN (${staffIdsSql})
          )`,
      [id],
    );
    tick("unanswered", t);
    const unanswered = (unansweredRows as any[])[0]?.cnt ?? 0;

    // 가장 오래된 미응답 1건 (180일 이내, 알림용)
    t = Date.now();
    const [oldestUnansweredRows] = await conn.query(
      `SELECT p.id, p.subject, p.reg_date, p.writer
         FROM tb_post p
        WHERE p.project_id = ? AND p.status = 1
          AND p.reg_date >= ${SINCE_14_SQL}
          AND p.user_id NOT IN (${staffIdsSql})
          AND NOT EXISTS (
            SELECT 1 FROM tb_post_comment c
             WHERE c.post_id = p.id AND c.status = 1
               AND c.user_id IN (${staffIdsSql})
          )
     ORDER BY p.reg_date ASC
        LIMIT 1`,
      [id],
    );
    tick("oldestUnanswered", t);
    const oldestUnanswered = (oldestUnansweredRows as any[])[0];

    // 평균 첫 응답 시간 — raw pair 만 가져와서 JS에서 영업시간 계산
    // (월~금 09:00~17:00 KST, 한국 공휴일 제외, 180일 이내 글만)
    t = Date.now();
    const [frtRows] = await conn.query(
      `SELECT p.reg_date AS post_at, MIN(c.reg_date) AS first_at
         FROM tb_post p
         JOIN tb_post_comment c ON c.post_id = p.id
        WHERE p.project_id = ? AND p.status = 1 AND c.status = 1
          AND p.reg_date >= ${SINCE_14_SQL}
          AND c.user_id IN (${staffIdsSql})
     GROUP BY p.id, p.reg_date`,
      [id],
    );
    const businessMinutes = (frtRows as any[])
      .map((r) => {
        const a = parseKst14ToMs(r.post_at);
        const b = parseKst14ToMs(r.first_at);
        if (a == null || b == null) return null;
        return businessMinutesBetween(a, b);
      })
      .filter((m): m is number => m != null);
    const avgMinutes =
      businessMinutes.length > 0
        ? businessMinutes.reduce((acc, x) => acc + x, 0) / businessMinutes.length
        : NaN;
    tick("frt", t);
    const avgFRT = formatBusinessFrt(Number.isFinite(avgMinutes) ? avgMinutes : null);
    // 영업시간 분 기준 등급 (1영업일 = 480min)
    const avgFRTGrade = (() => {
      if (!Number.isFinite(avgMinutes)) return "데이터 없음";
      if (avgMinutes < 60) return "매우 빠름";
      if (avgMinutes < 240) return "빠른 편"; // 4h 이내
      if (avgMinutes < 480) return "보통";    // 1영업일 이내
      if (avgMinutes < 1440) return "느린 편"; // 3영업일 이내
      return "응답 지연";
    })();

    // ── Briefing 객체 조립 ──────────────────────────────
    const members = memberRows as any[];
    // 분류: staff / partner / customer (협력사 화이트리스트 적용)
    const annotated = members.map((m) => ({ ...m, kind: classifyUser(m) }));
    const staffs = annotated.filter((m) => m.kind === "staff");
    const partners = annotated.filter((m) => m.kind === "partner");
    const pureCustomers = annotated.filter((m) => m.kind === "customer");
    const hasRecentActivity = members.length > 0;

    // 이름 없는 user는 email 로컬파트로 fallback
    const displayName = (m: any): string => {
      const n = String(m?.name ?? "").trim();
      if (n) return n;
      const e = String(m?.email ?? "");
      const local = e.includes("@") ? e.split("@")[0] : e;
      return local || "(이름 미상)";
    };
    // name이 있는 사람 우선 정렬
    const byNamePresent = (a: any, b: any) => {
      const an = String(a?.name ?? "").trim() ? 1 : 0;
      const bn = String(b?.name ?? "").trim() ? 1 : 0;
      return bn - an;
    };
    const sortedCustomers = [...pureCustomers].sort(byNamePresent);
    const sortedPartners = [...partners].sort(byNamePresent);
    // primary는 순수 고객 우선, 없으면 협력사
    const primaryCustomer = sortedCustomers[0] ?? sortedPartners[0] ?? null;
    const primaryIsPartner = !!primaryCustomer && isPartner(primaryCustomer);
    const monthOf = (d: string | null) => (d && d.length >= 6 ? `${d.slice(0, 4)}-${d.slice(4, 6)}` : null);

    const alerts: any[] = [];
    if (oldestUnanswered) {
      alerts.push({
        level: "warn",
        title: "응답 누락 추정",
        detail: oldestUnanswered.subject,
        meta: `${oldestUnanswered.writer} · ${toIso(oldestUnanswered.reg_date)?.slice(0, 10)} · post ${oldestUnanswered.id}`,
        hint: "우선 확인",
        postId: oldestUnanswered.id,
      });
    }
    if (unanswered >= 3) {
      alerts.push({
        level: "danger",
        title: `미응답 누적 ${unanswered}건`,
        hint: "응대 인력 점검 필요",
      });
    }

    // 상태 라벨 — 5단계 enum, DB 임계값으로 고정 (LLM이 덮어쓰지 않음)
    //   휴면: 180일 활동 없음
    //   원활: 미응답 0
    //   주의: 미응답 1~5
    //   경고: 미응답 6~15
    //   긴급: 미응답 > 15
    // (LLM이 추정한 urgent ≥ 5 도 긴급 후보 — extras 응답 받은 후 후처리에서 격상)
    let statusLabel: "휴면" | "원활" | "주의" | "경고" | "긴급";
    let statusReason: string;
    const unansweredNum = Number(unanswered);
    if (!hasRecentActivity) {
      statusLabel = "휴면";
      statusReason = `최근 ${RECENT_DAYS}일 문의 없음`;
    } else if (unansweredNum === 0) {
      statusLabel = "원활";
      statusReason = `최근 ${RECENT_DAYS}일 미응답 없음`;
    } else if (unansweredNum <= 5) {
      statusLabel = "주의";
      statusReason = `최근 ${RECENT_DAYS}일 미응답 ${unansweredNum}건`;
    } else if (unansweredNum <= 15) {
      statusLabel = "경고";
      statusReason = `최근 ${RECENT_DAYS}일 미응답 ${unansweredNum}건 누적`;
    } else {
      statusLabel = "긴급";
      statusReason = `최근 ${RECENT_DAYS}일 미응답 ${unansweredNum}건 — 응대 인력 점검 필요`;
    }

    const briefing = {
      meta: {
        projectId: proj.id,
        projectName: proj.name,
        active: proj.status === 1,
        statusLabel,
        statusReason,
        subtitle: proj.description?.slice(0, 80) ?? proj.buyer ?? "",
        lifecycle: proj.status === 1 ? "유지보수 진행" : "종료",
        builtAt: monthOf(stats0.first_post) ?? "",
        lastActivity: monthOf(stats0.last_post) ?? "",
        generatedAt: new Date().toISOString().slice(0, 10),
        domainRule: "@malgnsoft.com → 직원 / 그 외 → 고객",
        recentDays: RECENT_DAYS,
        hasRecentActivity,
        statusRule: "휴면(180일 0건) / 원활(미응답 0) / 주의(1~5) / 경고(6~15) / 긴급(>15 또는 LLM urgent≥5)",
      },
      customer: {
        primary: primaryCustomer
          ? {
              name: displayName(primaryCustomer),
              email: primaryCustomer.email,
              role: primaryIsPartner
                ? `협력사${primaryCustomer.rank ? ` · ${primaryCustomer.rank}` : ""}`
                : (primaryCustomer.rank || primaryCustomer.company || "담당"),
            }
          : { name: hasRecentActivity ? "(최근 고객 멤버 없음)" : `(최근 ${RECENT_DAYS}일 문의 없음)`, email: "", role: "" },
        others: sortedCustomers
          .filter((m) => m !== primaryCustomer)
          .slice(0, 8)
          .map((m) => ({
            name: displayName(m),
            email: m.email,
            role: m.rank || m.company || "고객",
          })),
        note: pureCustomers.length > 9
          ? `+ ${pureCustomers.length - 9}명`
          : undefined,
      },
      partners: sortedPartners.map((m) => ({
        name: displayName(m),
        email: m.email,
        company: m.company || "",
        rank: m.rank || "",
      })),
      staff: {
        primary: (staffRows as any[]).slice(0, 5).map((r) => ({
          role: r.rank || "직원",
          name: r.name,
          count: Number(r.cnt),
        })),
        aux: (staffRows as any[]).slice(5).map((r) => ({
          name: r.name,
          count: Number(r.cnt),
        })),
      },
      stats: {
        total: Number(stats0.total ?? 0),  // 전체 누적
        recent: Number(stats0.recent_total ?? 0), // 180일 문의수
        recentDays: RECENT_DAYS,
        avgFRT,                            // 180일 이내 영업시간
        avgFRTGrade,                       // 매우 빠름 / 빠른 편 / 보통 / 느린 편 / 응답 지연
        avgFRTNote: `${avgFRTGrade} · 영업시간 기준 (평일 ${BUSINESS_START_HOUR}:00~${BUSINESS_END_HOUR}:00, 공휴일 제외)`,
        avgFRTSampleSize: businessMinutes.length,
        unanswered: Number(unanswered),    // 180일 이내
        urgent: 0,                          // LLM (180일 이내)
      },
      hotTopics: [], // LLM 영역 (전체)
      hotLabels: (labelRows as any[]).map((r) => ({
        name: r.label,
        count: Number(r.cnt),
      })),
      alerts,         // 180일 이내 기반
      faq: [],        // LLM 영역 (전체)
      policies: [],   // LLM 영역 (전체)
    };

    return { briefing, staffIds };
}

// GET: 즉시 집계 (DB only) — 캐시 사용 안 함, 저장 안 함
app.get("/pms/projects/:id/briefing", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const result = await buildBriefingDbOnly(conn, id);
    if (!result) return c.json({ error: "not found" }, 404);
    return c.json({ briefing: result.briefing });
  }),
);

// POST: 새 브리핑 카드 생성 — hp_briefing 저장 + LLM(hotTopics)
//   캐시: 동일 input_hash + 24h 이내면 LLM 미호출. ?force=1로 우회.
//   LLM 실패 시 graceful degrade — DB-only 브리핑은 그대로 저장.
app.post("/pms/projects/:id/briefing/generate", requireAuth, requireServiceToken, rateLimitLlm, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const force = c.req.query("force") === "1";
    const skipLlm = c.req.query("nollm") === "1";
    const t0 = Date.now();
    const route = `POST /pms/projects/${id}/briefing/generate`;

    // ── 캐시 lookup (quick check 2 쿼리) ──────────────────
    // tb_post와 tb_post_comment의 최신 reg_date 조합으로 데이터 변동을 감지.
    // 이 둘이 같으면 13개 SQL을 다 침해서 buildBriefingDbOnly 호출할 필요 없음.
    if (!force) {
      const [tickPost] = await conn.query(
        `SELECT MAX(reg_date) AS t FROM tb_post WHERE project_id = ? AND status = 1`,
        [id],
      );
      const [tickComment] = await conn.query(
        `SELECT MAX(c.reg_date) AS t
           FROM tb_post_comment c
           JOIN tb_post p ON p.id = c.post_id
          WHERE p.project_id = ? AND c.status = 1`,
        [id],
      );
      const tickP = String((tickPost as any[])[0]?.t ?? "");
      const tickC = String((tickComment as any[])[0]?.t ?? "");
      const cacheTick = `${tickP}|${tickC}`;

      const [cacheRows] = await conn.query(
        `SELECT id, briefing_json, generated_at FROM hp_briefing
          WHERE project_id = ? AND status = 1 AND llm_input_hash = ?
            AND generated_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
          ORDER BY generated_at DESC LIMIT 1`,
        [id, cacheTick],
      );
      const cached = (cacheRows as any[])[0];
      if (cached) {
        const cachedBrief = JSON.parse(cached.briefing_json);
        // 옛 schema (persona 도입 전) 캐시는 자동 폐기하고 새로 생성
        const schemaOk =
          cachedBrief?.customer?.persona !== undefined ||
          cachedBrief?.staff?.persona !== undefined;
        if (schemaOk) {
          await conn.query(
            `INSERT INTO hp_llm_log (route, entity_type, entity_id, model, latency_ms, cache_hit)
             VALUES (?, 'briefing', ?, 'cache', ?, 1)`,
            [route, cached.id, Date.now() - t0],
          );
          return c.json({
            briefing: cachedBrief,
            cached: true,
            id: cached.id,
            generatedAt: cached.generated_at,
          });
        }
        // schemaOk 가 아니면 fall-through → 아래 buildBriefingDbOnly + LLM 새로
      }
    }

    // 캐시 miss — buildBriefingDbOnly 실행
    const dbTimings: Record<string, number> = {};
    const tBuildStart = Date.now();
    const built = await buildBriefingDbOnly(conn, id, dbTimings);
    dbTimings.buildTotal = Date.now() - tBuildStart;
    if (!built) return c.json({ error: "not found" }, 404);
    const briefing = built.briefing;
    const staffIds = built.staffIds;
    const staffIdsSql = staffIds.length > 0 ? staffIds.join(",") : "0";

    // 새 캐시 키: 같은 tick (위 quick check 와 동일 식). force=1이면 위에서 skip 했으므로 다시 계산.
    const [tickPostNew] = await conn.query(
      `SELECT MAX(reg_date) AS t FROM tb_post WHERE project_id = ? AND status = 1`,
      [id],
    );
    const [tickCommentNew] = await conn.query(
      `SELECT MAX(c.reg_date) AS t
         FROM tb_post_comment c
         JOIN tb_post p ON p.id = c.post_id
        WHERE p.project_id = ? AND c.status = 1`,
      [id],
    );
    const inputHash = `${String((tickPostNew as any[])[0]?.t ?? "")}|${String((tickCommentNew as any[])[0]?.t ?? "")}`;

    // ── LLM: hotTopics + extras (oneLiner / urgent / faq / policies) ─
    let generator: "db_only" | "hybrid" = "db_only";
    let llmModel: string | null = null;
    let llmPromptTokens: number | null = null;
    let llmCompletionTokens: number | null = null;
    let llmLatencyMs: number | null = null;
    let llmCostUsd: number | null = null;
    let llmError: string | null = null;

    function accumulate(r: { model: string; promptTokens: number; completionTokens: number; latencyMs: number; costUsd: number }) {
      llmModel = r.model;
      llmPromptTokens = (llmPromptTokens ?? 0) + r.promptTokens;
      llmCompletionTokens = (llmCompletionTokens ?? 0) + r.completionTokens;
      // 병렬 호출이므로 wall-clock은 max
      llmLatencyMs = Math.max(llmLatencyMs ?? 0, r.latencyMs);
      llmCostUsd = (llmCostUsd ?? 0) + r.costUsd;
      generator = "hybrid";
    }

    if (!skipLlm && c.env.OPENAI_API_KEY) {
      const tLlmInputStart = Date.now();
      // 입력 1: 전체 최근 제목 100개 (hotTopics/faq용)
      const [titleRows] = await conn.query(
        `SELECT subject FROM tb_post
          WHERE project_id = ? AND status = 1 AND subject IS NOT NULL AND subject != ''
       ORDER BY reg_date DESC LIMIT 100`,
        [id],
      );
      const titles = (titleRows as any[])
        .map((r) => String(r.subject ?? "").trim())
        .filter((t) => t.length > 0);

      // 입력 2: 180일 이내 제목 (urgent 추정용)
      const [recentTitleRows] = await conn.query(
        `SELECT subject FROM tb_post
          WHERE project_id = ? AND status = 1
            AND subject IS NOT NULL AND subject != ''
            AND reg_date >= ${SINCE_14_SQL}
       ORDER BY reg_date DESC LIMIT 100`,
        [id],
      );
      const recentTitles = (recentTitleRows as any[])
        .map((r) => String(r.subject ?? "").trim())
        .filter((t) => t.length > 0);

      // 입력 4: 180일 이내 고객 메시지 본문 (글+댓글, 비공개·직원·협력사 제외 → JS 필터)
      const [customerVoiceRows] = await conn.query(
        `SELECT 'post' AS kind, p.subject AS subject, SUBSTRING(p.content, 1, 1000) AS body,
                u.name AS u_name, u.email AS u_email, u.company AS u_company, p.reg_date
           FROM tb_post p
           JOIN tb_user u ON u.id = p.user_id
          WHERE p.project_id = ? AND p.status = 1
            AND p.reg_date >= ${SINCE_14_SQL}
            AND p.user_id NOT IN (${staffIdsSql})
            AND p.content IS NOT NULL AND CHAR_LENGTH(p.content) > 10
       ORDER BY p.reg_date DESC LIMIT 30`,
        [id],
      );
      const [customerCommentRows] = await conn.query(
        `SELECT 'comment' AS kind, '' AS subject, SUBSTRING(c.content, 1, 1000) AS body,
                u.name AS u_name, u.email AS u_email, u.company AS u_company, c.reg_date
           FROM tb_post_comment c
           JOIN tb_user u ON u.id = c.user_id
           JOIN tb_post p ON p.id = c.post_id
          WHERE p.project_id = ? AND c.status = 1
            AND c.reg_date >= ${SINCE_14_SQL}
            AND c.private_yn != 'Y'
            AND c.user_id NOT IN (${staffIdsSql})
            AND c.content IS NOT NULL AND CHAR_LENGTH(c.content) > 10
       ORDER BY c.reg_date DESC LIMIT 30`,
        [id],
      );
      const customerVoices = ([...(customerVoiceRows as any[]), ...(customerCommentRows as any[])])
        .filter((r) => !isPartner({ name: r.u_name, company: r.u_company }))
        .slice(0, 30)
        .map((r) => ({
          kind: r.kind as "post" | "comment",
          subject: String(r.subject ?? "").trim(),
          body: String(r.body ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 500),
        }))
        .filter((v) => v.body.length > 0);

      // 입력 3: 최근 staff 댓글 본문 20건 (policies 추출용, 비공개 제외, 전체 기간)
      const [staffMsgRows] = await conn.query(
        `SELECT SUBSTRING(c.content, 1, 800) AS content
           FROM tb_post_comment c
           JOIN tb_post p ON p.id = c.post_id
          WHERE p.project_id = ? AND c.status = 1
            AND c.user_id IN (${staffIdsSql})
            AND c.private_yn != 'Y'
            AND c.content IS NOT NULL AND c.content != ''
       ORDER BY c.reg_date DESC LIMIT 20`,
        [id],
      );
      dbTimings.llmInputs = Date.now() - tLlmInputStart;
      const staffMessages = (staffMsgRows as any[])
        .map((r) => String(r.content ?? "").replace(/\s+/g, " ").slice(0, 400))
        .filter((s) => s.length > 0);

      if (titles.length >= 5) {
        // ── LLM 1·2 병렬 호출 ─────────────────────────────
        const summary = {
          projectName: briefing.meta.projectName,
          total: briefing.stats.total,
          unanswered: briefing.stats.unanswered,
          avgFRT: briefing.stats.avgFRT,
          lastActivity: briefing.meta.lastActivity,
          staffCount: briefing.staff.primary.length + briefing.staff.aux.length,
          customerPrimary: briefing.customer.primary?.name,
        };

        const topicsPromise = callOpenAiJson<{ topics: Array<{ name: string; count: number }> }>(
          c.env,
          {
            system:
              "You analyze Korean customer support inquiry titles and cluster them into 3 to 7 topics. " +
              'Reply with JSON: {"topics":[{"name":"<짧은 한국어, 4단어 이내>","count":<int>}, ...]}. ' +
              "Sort topics by count desc. Counts should approximate how many titles belong to each topic.",
            user:
              "다음은 한 프로젝트의 최근 고객 문의 제목 목록입니다. 의미 단위로 3~7개 토픽으로 군집화하고, 각 토픽의 건수를 추정해 주세요.\n\n" +
              titles.map((t, i) => `${i + 1}. ${t}`).join("\n"),
            maxTokens: 500,
            temperature: 0.2,
          },
        );

        const extrasPromise = callOpenAiJson<{
          urgentCount: number;
          faq: string[];
          policies: Array<{ title: string; detail: string; source: string }>;
          customerPersona?: {
            tone: string;
            communicationStyle: string;
            traits: string[];
            summary: string;
          };
          staffPersona?: {
            tone: string;
            communicationStyle: string;
            traits: string[];
            summary: string;
          };
        }>(c.env, {
          system: [
            "You analyze a Korean customer support project and extract additional briefing fields.",
            "Inputs have TWO distinct time windows — be careful which window each output uses:",
            "  · RECENT_180 = 최근 180일 문의 (긴급도·고객 톤 신호용)",
            "  · ALL = 전체 누적 문의 (반복 패턴·운영 정책 추출용)",
            "",
            "Output strict JSON (statusLabel·statusReason은 시스템이 별도 룰로 결정 — LLM 출력 X):",
            '{ "urgentCount":<RECENT_180 제목 중 긴급/장애/오류성 추정 건수, int>,',
            '  "faq":["<ALL 기준 자주 묻는 질문 패턴 1>","<2>","<3>", ...]   // 3~6개, 각 30자 이내,',
            '  "policies":[{"title":"<짧은 정책명>","detail":"<2~3문장>","source":"<출처 요약, 예: 직원 응답 패턴>"}, ...]  // 0~3개, 직원 응답(ALL)에서 일관되게 관찰되는 응답 규칙만,',
            '  "customerPersona":{',
            '    "tone":"<짧은 한국어 형용사 1~2개, 예: 정중·차분 / 긴급·짜증 / 사무적>",',
            '    "communicationStyle":"<한 줄, 30자 이내>",',
            '    "traits":["<형용사/특징 1>","<2>","<3>", ...3~5개],',
            '    "summary":"<1~2문장, 자연어 묘사>"',
            "  },",
            '  "staffPersona":{',
            '    "tone":"<상담사 답변의 짧은 한국어 형용사 1~2개, 예: 신속·친절 / 사무적·정확 / 격식>",',
            '    "communicationStyle":"<한 줄, 30자 이내>",',
            '    "traits":["<형용사/특징 1>","<2>","<3>", ...3~5개],',
            '    "summary":"<1~2문장, 자연어 묘사>"',
            "  }",
            "}",
            "규칙:",
            "  · urgentCount/customerPersona는 RECENT_180 기준",
            "  · staffPersona는 ALL 기준 (전체 직원 응답 본문 기반)",
            "  · faq/policies는 ALL 기준",
            "  · customerPersona·staffPersona는 절대 빠뜨리지 말 것. 입력이 적어도 추정으로 채울 것 (필요시 tone='데이터 부족' 같이라도)",
            "  · customerPersona = 고객사 평균 문의 톤·태도",
            "  · staffPersona = 상담사(직원) 평균 답변 톤·태도",
          ].join("\n"),
          user: [
            `프로젝트 통계 (RECENT_180): ${JSON.stringify(summary)}`,
            "",
            `=== RECENT_180 — 최근 180일 문의 제목 (${recentTitles.length}건) ===`,
            recentTitles.length > 0
              ? recentTitles.slice(0, 100).map((t, i) => `${i + 1}. ${t}`).join("\n")
              : "(없음)",
            "",
            `=== RECENT_180 — 고객 메시지 본문 (${customerVoices.length}건, 비공개·직원·협력사 제외, 최신순) ===`,
            customerVoices.length > 0
              ? customerVoices
                  .map((v, i) => `${i + 1}. [${v.kind}]${v.subject ? ` (${v.subject})` : ""} ${v.body}`)
                  .join("\n")
              : "(없음)",
            "",
            `=== ALL — 전체 누적 문의 제목 (최대 100건, 최신순) ===`,
            titles.slice(0, 100).map((t, i) => `${i + 1}. ${t}`).join("\n"),
            "",
            `=== ALL — 직원 응답 본문 (최대 20건, 비공개 제외) ===`,
            staffMessages.map((m, i) => `${i + 1}. ${m}`).join("\n"),
          ].join("\n"),
          maxTokens: 1200,
          temperature: 0.2,
        });

        // 한쪽 실패해도 나머지는 유지 — allSettled
        const [topicsR, extrasR] = await Promise.allSettled([topicsPromise, extrasPromise]);

        if (topicsR.status === "fulfilled") {
          briefing.hotTopics = (topicsR.value.data.topics ?? []).slice(0, 7);
          accumulate(topicsR.value);
        } else {
          llmError = `hotTopics: ${(topicsR.reason as Error).message}`;
        }

        if (extrasR.status === "fulfilled") {
          const v = extrasR.value;
          // statusLabel·statusReason은 DB 임계값 룰이 결정 — LLM이 덮어쓰지 않음
          // (LLM이 입력을 잘못 해석하는 경우가 있어 폴백 사실값을 보장)
          if (typeof v.data.urgentCount === "number") {
            briefing.stats.urgent = v.data.urgentCount;
            // urgent ≥ 5 면 '긴급'으로 격상 + 사유도 교체
            if (
              v.data.urgentCount >= 5 &&
              briefing.meta.statusLabel !== "휴면" &&
              briefing.meta.statusLabel !== "원활" &&
              briefing.meta.statusLabel !== "긴급"
            ) {
              briefing.meta.statusLabel = "긴급";
              briefing.meta.statusReason = `긴급 문의 ${v.data.urgentCount}건 추정 — 우선 확인`;
            }
          }
          briefing.faq = (v.data.faq ?? []).filter((s) => typeof s === "string").slice(0, 6);
          briefing.policies = (v.data.policies ?? []).slice(0, 3).map((p) => ({
            title: String(p.title ?? "").slice(0, 50),
            detail: String(p.detail ?? "").slice(0, 300),
            source: String(p.source ?? "").slice(0, 80),
          }));
          // 고객 톤·태도·특징 (RECENT_180 고객 메시지 기반)
          const persona = v.data.customerPersona;
          if (persona && (persona.tone || persona.summary || (persona.traits && persona.traits.length))) {
            briefing.customer.persona = {
              tone: String(persona.tone ?? "").slice(0, 30),
              communicationStyle: String(persona.communicationStyle ?? "").slice(0, 80),
              traits: (persona.traits ?? [])
                .filter((s: unknown) => typeof s === "string")
                .slice(0, 6)
                .map((s: string) => s.slice(0, 30)),
              summary: String(persona.summary ?? "").slice(0, 300),
              sampleSize: customerVoices.length,
            };
          }
          // 상담사 답변 톤·태도·특징 (ALL 직원 응답 본문 기반)
          const sp = v.data.staffPersona;
          if (sp && (sp.tone || sp.summary || (sp.traits && sp.traits.length))) {
            briefing.staff.persona = {
              tone: String(sp.tone ?? "").slice(0, 30),
              communicationStyle: String(sp.communicationStyle ?? "").slice(0, 80),
              traits: (sp.traits ?? [])
                .filter((s: unknown) => typeof s === "string")
                .slice(0, 6)
                .map((s: string) => s.slice(0, 30)),
              summary: String(sp.summary ?? "").slice(0, 300),
              sampleSize: staffMessages.length,
            };
          }
          accumulate(v);
        } else {
          const prev = llmError ? `${llmError}; ` : "";
          llmError = `${prev}extras: ${(extrasR.reason as Error).message}`;
        }
      }
    }

    const totalLatency = Date.now() - t0;
    const [ins] = await conn.query(
      `INSERT INTO hp_briefing
         (project_id, generated_at, generator, llm_model, llm_input_hash,
          prompt_tokens, completion_tokens, latency_ms, briefing_json)
       VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        generator,
        llmModel,
        inputHash,
        llmPromptTokens,
        llmCompletionTokens,
        totalLatency,
        JSON.stringify(briefing),
      ],
    );
    const insertId = (ins as any).insertId as number;

    await conn.query(
      `INSERT INTO hp_llm_log
         (route, entity_type, entity_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd, cache_hit, error)
       VALUES (?, 'briefing', ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        route,
        insertId,
        llmModel ?? "db_only",
        llmPromptTokens,
        llmCompletionTokens,
        llmLatencyMs ?? totalLatency,
        llmCostUsd,
        llmError,
      ],
    );

    return c.json({
      briefing,
      cached: false,
      id: insertId,
      generator,
      llm: llmModel
        ? { model: llmModel, promptTokens: llmPromptTokens, completionTokens: llmCompletionTokens, costUsd: llmCostUsd, latencyMs: llmLatencyMs }
        : null,
      llmError,
      timings: dbTimings,
    });
  }),
);

// GET: 프로젝트의 저장된 브리핑 목록 (히스토리 selectbox용, 메타만)
app.get("/pms/projects/:id/briefings", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
    const [rows] = await conn.query(
      `SELECT id, generated_at, generator, llm_model, llm_input_hash, latency_ms
         FROM hp_briefing
        WHERE project_id = ? AND status = 1
     ORDER BY generated_at DESC
        LIMIT ${limit}`,
      [id],
    );
    return c.json({ rows });
  }),
);

// GET: 저장된 브리핑 단건 (briefing_json 파싱)
app.get("/pms/briefings/:id", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const [rows] = await conn.query(
      `SELECT id, project_id, generated_at, generator, llm_model, briefing_json
         FROM hp_briefing WHERE id = ? AND status = 1`,
      [id],
    );
    const r = (rows as any[])[0];
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({
      id: r.id,
      projectId: r.project_id,
      generatedAt: r.generated_at,
      generator: r.generator,
      llmModel: r.llm_model,
      briefing: JSON.parse(r.briefing_json),
    });
  }),
);

// DELETE: 저장된 브리핑 soft-delete
app.delete("/pms/briefings/:id", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    await conn.query(`UPDATE hp_briefing SET status = -1 WHERE id = ?`, [id]);
    return c.json({ ok: true });
  }),
);

// ── Q&A 평가 카드 (hp_qa_eval) ───────────────────────────
// 게시글 1건 + 첫 staff 응답을 LLM이 5축으로 평가하고 JSON 반환.

const QA_SYSTEM_PROMPT = [
  "You evaluate Korean customer support Q&A interactions.",
  "Inputs: an inquiry post + its first staff reply (Korean).",
  "Output strict JSON matching the schema below. Comments in Korean.",
  "",
  "Score 5 axes A~E, each 1-5 integer (or string 'warn' if unscorable):",
  "  A 응답 속도 (FRT 적정성)",
  "  B 정확성 (질문 의도와 답 내용의 일치)",
  "  C 명확성 (이해하기 쉬운 문장·구조)",
  "  D 표준화 가능성 (재사용 가능한 답변인지) + templates 6개 제안",
  "  E 친절도·태도 (어조, 공감)",
  "",
  "JSON schema:",
  '{ "oneLiner":"<한 줄 평>",',
  '  "axes":[',
  '    {"letter":"A","title":"응답 속도","score":4,"scoreLabel":"양호","commentary":"...","bullets":[{"text":"...","emphasis":"high|normal"}]},',
  '    {"letter":"B",...},',
  '    {"letter":"C",...},',
  '    {"letter":"D","title":"표준화 가능성","score":3,"commentary":"...","templates":[{"label":"<기본>","question":"<질문 패턴>","answer":"<상담사가 그대로 복사·발송 가능한 완성된 HTML 답변. <p>·<ol>·<li>·<strong>·<a>·<img> 등 활용. 원본 응답에 <img> 또는 첨부가 있으면 같은 src/href를 그대로 포함>"}]},',
  '    {"letter":"E",...}',
  '  ],',
  '  "overallVerdict":"<종합 평 한 줄>",',
  '  "observation":{"title":"...","body":"...","hint":"..."} }',
  "",
  "Rules: bullets·observation는 의미 있을 때만 채우고 비어도 됨.",
  "",
  "── 이미지 처리 (중요) ──",
  "user 메시지에 image_url로 원본 응답의 스크린샷 이미지가 첨부될 수 있다. 첨부 순서대로 [이미지1], [이미지2] … 로 지칭.",
  "각 이미지가 무엇을 보여주는지(메뉴 위치/입력 화면/버튼/결과 등) 시각적으로 분석하고, 답변에 이미지를 배치할 때 다음 규칙 엄수:",
  "  ◈ 단순 <img src=\"...\"> 만 넣지 말고, 이미지 앞에 1~2줄 안내(예: <p><strong>1단계 — 좌측 메뉴에서 [SMS 신청] 선택</strong></p>) + 이미지 + 이미지 아래 짧은 캡션(<figcaption> 또는 작은 <p>)을 함께 배치.",
  "  ◈ 캡션은 추측 금지. 이미지에 실제 보이는 메뉴명·버튼명·필드명을 그대로 옮긴다.",
  "  ◈ 단계별 가이드(4번 변형)의 각 <li>에는 [그 단계에 해당하는 이미지 1장 + 캡션]을 반드시 포함.",
  "  ◈ 상세 변형에도 핵심 화면 이미지가 있으면 적절히 배치(과하지 않게 1~2장).",
  "  ◈ 이미지가 0장이면 본문만 작성하면 됨.",
  "",
  "── templates 6개 작성 규칙(엄수) ──",
  "  ◈ 형식: 반드시 HTML. 모든 문장은 <p>...</p>로 감싸고, 목록은 <ol>/<ul>, 강조는 <strong>.",
  "  ◈ ★문단 분리(매우 중요): 한 <p>에 모든 내용을 몰아넣지 말 것. 의미 단위마다 <p>를 끊는다.",
  "      [인사] → <p>안녕하세요, 고객님.</p>",
  "      [공감/상황 확인] → <p>OO 관련 문제로 불편을 드려 죄송합니다.</p>",
  "      [핵심 답/절차] → <p>...</p>  또는 <ol><li>...</li></ol>",
  "      [보조 정보·예외·링크] → 별도 <p> 또는 <ul>",
  "      [마무리/추가 안내] → <p>추가로 궁금한 점 있으시면 언제든 문의 부탁드립니다.</p>",
  "      → 짧은 답변이라도 최소 3개의 <p>로 분리. 한 덩어리 텍스트 금지.",
  "  ◈ 절차가 2단계 이상이면 반드시 <ol><li>...</li></ol>로 시각화. 인라인 '먼저 X하고 그다음 Y하고'식 금지.",
  "  ◈ 링크: 원본의 <a href=\"...\"> 다운로드/외부 링크도 같은 href로 보존.",
  "  ◈ 내용 풍부화: '안녕하세요. X입니다.' 같은 1줄 답변 절대 금지. 최소한 ① 인사 ② 핵심 답 ③ 보조 정보 ④ 마무리 4파트.",
  "  ◈ 컨텍스트 활용: user 메시지에 '관련 표준답변' 섹션이 있으면, 표현·문장 구조를 참고해 일관된 톤으로 작성. 본문 복붙은 금지, 재구성.",
  "  ◈ 일반화: 특정 고객명·계약번호·이메일 등 개인 정보는 빼고 누구에게나 적용 가능한 형태로.",
  "  ◈ 6개 변형 (용도 중심, label 정확히 일치): '기본' / '요약' / '상세' / '단계별 가이드' / '공감·사과 톤' / '격식·공식 톤'.",
  "    - 기본: 표준 답변. ① 인사 ② 핵심 답 ③ 근거·보조 정보 ④ 마무리 4파트, 3~5개 <p>. 정중·중립 톤. 대부분 그대로 복사·발송 가능한 '대표' 답변. 이미지 0~1장.",
  "    - 요약: 핵심만 빠르게. 2~3개 <p>, 결론 우선·군더더기 없이. 바쁜 고객/간단 문의용. 이미지 0장.",
  "    - 상세: 절차·조건·예외·관련 정책까지 모두 포함. 5~7개 <p>, 절차는 <ol>. 이미지 1~2장.",
  "    - 단계별 가이드: 따라 하기형. 인사 <p> + <ol>(각 <li>에 '단계 설명 + 이미지 + 캡션') + 마무리 <p>. 인사·마무리는 <ol> 밖에. 화면 캡처가 있으면 단계마다 배치.",
  "    - 공감·사과 톤: 클레임·불만·지연 상황 완화용. 사과·공감으로 시작('불편을 드려 죄송합니다', '많이 답답하셨겠습니다') 후 핵심 답·재발 방지 안내. 4~5개 <p>. 이미지 0~1장.",
  "    - 격식·공식 톤: 공공기관·기업 대상 공문체. '안내드립니다', '~예정입니다', '확인 후 회신드리겠습니다' 등 격식·정중·단정한 문장. 4~6개 <p>. 이미지 1장.",
  "score가 정해지지 않으면 'warn' + scoreLabel='주의'.",
].join("\n");

// ── 안내글 평가 (게시글 작성자가 직원인 경우) ─────────────
// 직원이 작성한 공지·안내 성격의 게시글 자체를 3축으로 평가하고 3개 변형 추천.
const ANNOUNCE_SYSTEM_PROMPT = [
  "You evaluate Korean staff-authored announcement/notice posts (직원이 고객 대상 공지·안내로 작성한 게시글).",
  "Inputs: an announcement post body (Korean, may contain HTML images).",
  "Output strict JSON matching the schema below. Comments in Korean.",
  "",
  "Score 3 axes A~C, each 1-5 integer (or string 'warn' if unscorable):",
  "  A 톤·자세 (고객 대상 공지에 적절한 정중·격식·신뢰감)",
  "  B 명확성 (핵심이 먼저 나오는지, 한 번 읽고 이해 가능한지, 구조화)",
  "  C 완전성 (일자·연락처·조건·예외·절차 등 빠진 정보 없는지)",
  "",
  "JSON schema:",
  '{ "oneLiner":"<한 줄 평>",',
  '  "axes":[',
  '    {"letter":"A","title":"톤·자세","score":4,"scoreLabel":"양호","commentary":"...","bullets":[{"text":"...","emphasis":"high|normal"}]},',
  '    {"letter":"B","title":"명확성",...},',
  '    {"letter":"C","title":"완전성",...}',
  '  ],',
  '  "overallVerdict":"<종합 평 한 줄>",',
  '  "templates":[',
  '    {"label":"짧은","title":"<개선된 제목>","answer":"<짧은 안내글 — 핵심만, 3~4개 <p>>"},',
  '    {"label":"명료한","title":"...","answer":"<명료한 안내글 — 핵심+절차 구조화, 4~5개 <p> + 필요시 <ol>>"},',
  '    {"label":"자세한","title":"...","answer":"<자세한 안내글 — 절차/조건/예외/연락처 모두 포함, 5~7개 <p> + <ol>>"}',
  '  ],',
  '  "observation":{"title":"...","body":"...","hint":"..."} }',
  "",
  "Rules: bullets·observation는 의미 있을 때만 채우고 비어도 됨.",
  "",
  "── 이미지 처리 (원본에 <img>가 있다면) ──",
  "user 메시지에 image_url로 원본 안내글의 첨부 이미지가 같이 들어올 수 있다.",
  "  ◈ 시각적으로 무엇을 보여주는지 파악하고, templates 각 변형의 적절한 위치에 같은 src로 다시 배치 + 캡션(짧은 <p>) 작성.",
  "  ◈ 캡션은 추측 금지 — 이미지에 실제 보이는 메뉴명·날짜·표 헤더 등을 그대로 옮김.",
  "  ◈ 짧은 변형은 이미지 0~1장, 명료한 1~2장, 자세한 2~3장 권장.",
  "  ◈ 이미지가 0장이면 templates에도 <img> 넣지 말 것.",
  "",
  "── templates 3개 작성 규칙(엄수) ──",
  "  ◈ 형식: 반드시 HTML. 모든 문장은 <p>...</p>로 감싸고, 절차는 <ol><li>...</li></ol>, 강조는 <strong>.",
  "  ◈ ★문단 분리: 한 <p>에 모든 내용을 몰아넣지 말 것. 의미 단위마다 <p>를 끊는다.",
  "      [인사·도입] → <p>안녕하세요. ...</p>",
  "      [본문 핵심] → <p>...</p>  또는 <ol><li>...</li></ol>",
  "      [보조 정보·예외·일자·연락처] → 별도 <p>",
  "      [마무리] → <p>문의 사항은 ...</p>",
  "  ◈ 절차/단계가 2개 이상이면 반드시 <ol><li>...</li></ol>로 시각화.",
  "  ◈ 링크: 원본의 <a href=\"...\">는 같은 href로 보존.",
  "  ◈ 톤: 고객 대상 공지이므로 정중·격식·명료. '~드립니다', '~예정입니다', '~부탁드립니다'. 친근체·반말 금지.",
  "  ◈ 일반화: 특정 고객 개인 정보는 빼고 누구에게나 적용 가능한 형태로.",
  "  ◈ title은 안내글에 어울리는 한 줄 제목 (원본보다 명확·구체적).",
  "  ◈ 3개 변형 (label 정확히 일치): '짧은' / '명료한' / '자세한'.",
  "    - 짧은: 3~4개 <p>, 핵심 + 일자 + 문의처만. 절차 1~2단계면 인라인.",
  "    - 명료한: 4~5개 <p>, 핵심을 먼저 강조한 후 절차를 <ol>로 정리. 균형.",
  "    - 자세한: 5~7개 <p>, 절차 전체 + 조건·예외·문의처 모두 포함. <ol>은 단계별 캡션 포함.",
  "score가 정해지지 않으면 'warn' + scoreLabel='주의'.",
].join("\n");

app.post("/pms/posts/:id/announce-eval/generate", requireAuth, requireServiceToken, rateLimitLlm, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const force = c.req.query("force") === "1";
    const skipLlm = c.req.query("nollm") === "1";
    const t0 = Date.now();
    const route = `POST /pms/posts/${id}/announce-eval/generate`;

    // 1) 게시글 + 작성자 (staff 여부 검증)
    const [postRows] = await conn.query(
      `SELECT p.id, p.subject, p.content, p.project_id, p.reg_date,
              u.name AS u_name, u.email AS u_email, u.company AS u_company, u.rank AS u_rank,
              (u.email LIKE '%@malgnsoft.com' OR u.company = '맑은소프트') AS u_is_staff
         FROM tb_post p
    LEFT JOIN tb_user u ON u.id = p.user_id
        WHERE p.id = ? AND p.status = 1`,
      [id],
    );
    const post = (postRows as any[])[0];
    if (!post) return c.json({ error: "post not found" }, 404);
    if (post.u_is_staff !== 1) {
      return c.json({ error: "not a staff-authored post — use /eval/generate for customer posts" }, 422);
    }

    // 2) 프로젝트
    const [projRows] = await conn.query(
      `SELECT name FROM tb_project WHERE id = ?`,
      [post.project_id],
    );
    const projectName = (projRows as any[])[0]?.name ?? `프로젝트 #${post.project_id}`;

    const meta = {
      kind: "announce" as const, // UI에서 분기용
      postId: post.id,
      postTitle: post.subject,
      projectId: post.project_id,
      projectName,
      projectType: "PMS",
      projectStatus: "활성",
      author: {
        name: post.u_name ?? "(미상)",
        email: post.u_email ?? "",
        company: post.u_company ?? "",
        kind: "직원",
      },
      writtenAt: toIso(post.reg_date) ?? "",
      domainRule: "@malgnsoft.com 또는 맑은소프트 → 직원",
      generatedAt: new Date().toISOString().slice(0, 10),
    };

    // 캐시 키: 안내글 본문 해시
    const inputForHash = JSON.stringify({
      postId: id,
      kind: "announce",
      subject: post.subject,
      content: post.content?.slice(0, 8000) ?? "",
    });
    const inputHash = await sha256Hex(inputForHash);

    if (!force) {
      const [cacheRows] = await conn.query(
        `SELECT id, eval_json, generated_at FROM hp_qa_eval
          WHERE post_id = ? AND status = 1 AND llm_input_hash = ?
          ORDER BY generated_at DESC LIMIT 1`,
        [id, inputHash],
      );
      const cached = (cacheRows as any[])[0];
      if (cached) {
        await conn.query(
          `INSERT INTO hp_llm_log (route, entity_type, entity_id, model, latency_ms, cache_hit)
           VALUES (?, 'announce_eval', ?, 'cache', ?, 1)`,
          [route, cached.id, Date.now() - t0],
        );
        return c.json({ eval: JSON.parse(cached.eval_json), cached: true, id: cached.id });
      }
    }

    // ── LLM 평가 ──────────────────────────────────────────
    let llmResult: any = {
      oneLiner: "",
      axes: [],
      overallVerdict: "",
      templates: [],
      observation: undefined,
    };
    let generator: "db_only" | "hybrid" = "db_only";
    let llmModel: string | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let llmLatency: number | null = null;
    let costUsd: number | null = null;
    let llmError: string | null = null;

    if (!skipLlm && c.env.OPENAI_API_KEY) {
      try {
        // 안내글 본문 안 이미지 src 추출 → 절대 URL
        const imgPattern = /<img\s[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
        const content = String(post.content ?? "");
        const rawImgs = [...content.matchAll(imgPattern)].map((m) => m[1]);
        const assetBase = c.env.PMS_ASSET_BASE || DEFAULT_PMS_ASSET_BASE;
        const toAbsolute = (u: string): string => pmsAbsoluteUrl(u, assetBase);
        const visionImgs = rawImgs.map(toAbsolute).slice(0, 8);

        const userMsgParts = [
          `프로젝트: ${projectName}`,
          `작성자: ${meta.author.name} (직원)`,
          `작성 시각: ${meta.writtenAt}`,
          "",
          "=== 안내글 제목 ===",
          post.subject,
          "",
          "=== 안내글 본문 (HTML 원본) ===",
          content.slice(0, 12000),
          "",
          visionImgs.length > 0
            ? `=== 첨부 이미지 (${visionImgs.length}장) ===\n아래 image_url로 같이 첨부됨. 첨부 순서대로 [이미지1], [이미지2] … 로 지칭.\n각 이미지의 실제 내용을 파악하고, templates 각 변형에 적절히 배치(캡션 포함)하라.\n${visionImgs.map((s, i) => `[이미지${i + 1}] ${s}`).join("\n")}`
            : "(원본에 이미지 없음 — templates에 <img> 넣지 말 것)",
        ];

        const userMsg = userMsgParts.join("\n");
        const llm = await callOpenAiJson<typeof llmResult>(c.env, {
          model: visionImgs.length > 0 ? c.env.LLM_MODEL_PREMIUM : c.env.LLM_MODEL_DEFAULT,
          system: ANNOUNCE_SYSTEM_PROMPT,
          user: userMsg,
          images: visionImgs,
          maxTokens: 6000,
          temperature: 0.3,
          timeoutMs: 60_000,
        });
        llmResult = llm.data;
        generator = "hybrid";
        llmModel = llm.model;
        promptTokens = llm.promptTokens;
        completionTokens = llm.completionTokens;
        llmLatency = llm.latencyMs;
        costUsd = llm.costUsd;
      } catch (e) {
        llmError = (e as Error).message;
      }
    }

    const numericScores = (llmResult.axes ?? [])
      .map((a: any) => (typeof a.score === "number" ? a.score : null))
      .filter((s: any) => s !== null) as number[];
    const overallAverage =
      numericScores.length > 0
        ? Math.round((numericScores.reduce((a, b) => a + b, 0) / numericScores.length) * 10) / 10
        : 0;

    const announceEval = {
      meta,
      announcement: post.content ?? "",
      oneLiner: llmResult.oneLiner ?? "",
      axes: llmResult.axes ?? [],
      overallAverage,
      overallVerdict: llmResult.overallVerdict ?? "",
      templates: llmResult.templates ?? [],
      observation: llmResult.observation,
    };

    const totalLatency = Date.now() - t0;
    const [ins] = await conn.query(
      `INSERT INTO hp_qa_eval
         (post_id, project_id, generated_at, generator, llm_model, llm_input_hash,
          prompt_tokens, completion_tokens, latency_ms,
          eval_json, overall_score, overall_verdict)
       VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        post.project_id,
        generator === "hybrid" ? "announce_llm" : "announce_db",
        llmModel,
        inputHash,
        promptTokens,
        completionTokens,
        totalLatency,
        JSON.stringify(announceEval),
        overallAverage > 0 ? overallAverage : null,
        announceEval.overallVerdict ? announceEval.overallVerdict.slice(0, 100) : null,
      ],
    );
    const insertId = (ins as any).insertId as number;

    await conn.query(
      `INSERT INTO hp_llm_log
         (route, entity_type, entity_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd, cache_hit, error)
       VALUES (?, 'announce_eval', ?, ?, ?, ?, ?, ?, 0, ?)`,
      [route, insertId, llmModel ?? "db_only", promptTokens, completionTokens, llmLatency ?? totalLatency, costUsd, llmError],
    );

    return c.json({ eval: announceEval, cached: false, id: insertId, generator, llmError });
  }),
);

// 답변이 아직 없는 문의에 대한 추천 답변 6개 생성 prompt.
// 5축 평가는 수행 불가(답변 부재) → 추천 답변만 D축 1개에 담아 반환.
const QA_INQUIRY_ONLY_SYSTEM_PROMPT = [
  "You are helping a Korean customer support agent draft replies to a customer inquiry that has not been answered yet.",
  "Inputs: an inquiry post (Korean), optional related standard answers, optional inquiry-attached images.",
  "Goal: produce 6 candidate replies the agent can copy and send.",
  "Output strict JSON matching the schema below.",
  "",
  "JSON schema:",
  '{ "oneLiner":"<문의 요지 한 줄>",',
  '  "overallVerdict":"<답변 가이드 한 줄 — 어떤 톤·접근으로 답할지>",',
  '  "axes":[',
  '    {"letter":"D","title":"추천 답변","score":"info","scoreLabel":"추천","commentary":"<답변 작성 시 주의점 한 줄>","templates":[',
  '      {"label":"짧은 답변","question":"<문의 패턴>","answer":"<HTML>"},',
  '      {"label":"긴 답변","question":"...","answer":"<HTML>"},',
  '      {"label":"친절한 톤","question":"...","answer":"<HTML>"},',
  '      {"label":"비즈니스 톤","question":"...","answer":"<HTML>"},',
  '      {"label":"FAQ 형식","question":"...","answer":"<HTML>"},',
  '      {"label":"단계별 안내","question":"...","answer":"<HTML>"}',
  '    ]}',
  '  ],',
  '  "observation":null }',
  "",
  "templates 6개 작성 규칙(엄수):",
  "  ◈ 형식: 반드시 HTML. 모든 문장은 <p>로 감싸고, 목록은 <ol>/<ul>, 강조는 <strong>.",
  "  ◈ 문단 분리: 한 <p>에 몰지 말 것. [인사] [핵심 답/절차] [보조 정보·연락처·예외] [마무리] 등 의미 단위마다 별도 <p>.",
  "  ◈ 절차가 2단계 이상이면 <ol><li>...</li></ol>로 시각화. 인라인 '먼저 X하고 그다음 Y' 금지.",
  "  ◈ 내용 풍부화: 최소 ① 인사 ② 핵심 답(절차·조건·정책) ③ 보조 정보(예외·연관 안내·문의처) ④ 마무리 4파트.",
  "  ◈ 컨텍스트 활용: '관련 표준답변' 섹션이 있으면 톤·구조 참고. 본문 복붙 금지, 재구성.",
  "  ◈ 일반화: 특정 고객명·계약번호·이메일 등 개인 정보는 빼고 누구에게나 적용 가능한 형태로.",
  "  ◈ 답변 길이·디테일은 label에 맞게 (짧은 답변=3~4 <p>, 긴 답변=5~7 <p>, FAQ=Q/A 2~3쌍 등).",
  "  ◈ 단계별 안내: 인사 <p> + <ol>(단계별 <li>) + 마무리 <p>. 인사·마무리를 <ol> 안에 넣지 말 것.",
  "  ◈ 문의가 모호하면 commentary에 '추가 확인이 필요한 정보(예: 환경/버전/일자)'를 1~2줄 명시.",
].join("\n");

app.post("/pms/posts/:id/eval/generate", requireAuth, requireServiceToken, rateLimitLlm, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const force = c.req.query("force") === "1";
    const skipLlm = c.req.query("nollm") === "1";
    const t0 = Date.now();
    const route = `POST /pms/posts/${id}/eval/generate`;

    // 1) 게시글 + 문의자
    const [postRows] = await conn.query(
      `SELECT p.id, p.subject, p.content, p.project_id, p.reg_date,
              u.name AS u_name, u.email AS u_email, u.company AS u_company, u.rank AS u_rank,
              (u.email LIKE '%@malgnsoft.com' OR u.company = '맑은소프트') AS u_is_staff
         FROM tb_post p
    LEFT JOIN tb_user u ON u.id = p.user_id
        WHERE p.id = ? AND p.status = 1`,
      [id],
    );
    const post = (postRows as any[])[0];
    if (!post) return c.json({ error: "post not found" }, 404);

    // 2) 첫 staff 응답 (private_yn != 'Y' — 비공개 본문은 LLM에 입력 금지)
    const [respRows] = await conn.query(
      `SELECT c.id, c.content, c.reg_date, c.private_yn,
              u.name AS u_name, u.email AS u_email, u.rank AS u_rank
         FROM tb_post_comment c
         JOIN tb_user u ON u.id = c.user_id
        WHERE c.post_id = ? AND c.status = 1
          AND (u.email LIKE '%@malgnsoft.com' OR u.company = '맑은소프트')
        ORDER BY c.reg_date ASC
        LIMIT 1`,
      [id],
    );
    const resp = (respRows as any[])[0];

    // 3) 프로젝트 이름
    const [projRows] = await conn.query(
      `SELECT name FROM tb_project WHERE id = ?`,
      [post.project_id],
    );
    const projectName = (projRows as any[])[0]?.name ?? `프로젝트 #${post.project_id}`;

    // FRT 계산
    const frt = (() => {
      if (!resp?.reg_date) return "—";
      const post14 = post.reg_date as string;
      const resp14 = resp.reg_date as string;
      if (!post14 || !resp14 || post14.length !== 14 || resp14.length !== 14) return "—";
      const toDate = (s: string) =>
        new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`);
      const diffMin = Math.round((toDate(resp14).getTime() - toDate(post14).getTime()) / 60000);
      if (diffMin < 60) return `${diffMin}분`;
      if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}시간`;
      return `${Math.round(diffMin / (60 * 24))}일`;
    })();

    // QaMeta 조립
    const inquirerKind = post.u_is_staff === 1 ? "직원" : "고객";
    const meta = {
      postId: post.id,
      postTitle: post.subject,
      projectId: post.project_id,
      projectName,
      projectType: "PMS",
      projectStatus: "활성",
      inquirer: {
        name: post.u_name ?? "(미상)",
        email: post.u_email ?? "",
        kind: inquirerKind,
      },
      responder: resp
        ? { name: resp.u_name, email: resp.u_email, kind: "직원" }
        : { name: "(응답 없음)", email: "", kind: "직원" },
      inquiryAt: toIso(post.reg_date) ?? "",
      responseAt: toIso(resp?.reg_date ?? null) ?? "",
      frt,
      privateAnswer: resp?.private_yn === "Y", // 첫 응답이 비공개였는지 (drop된 경우)
      privateField: "private_yn = Y",
      domainRule: "@malgnsoft.com → 직원 / 그 외 → 고객",
      generatedAt: new Date().toISOString().slice(0, 10),
    };

    // 캐시 키: 본문 내용 해시 (LLM에 입력하는 것과 동일 범위)
    const inputForHash = JSON.stringify({
      postId: id,
      subject: post.subject,
      content: post.content?.slice(0, 5000) ?? "",
      response: resp?.content?.slice(0, 5000) ?? "",
    });
    const inputHash = await sha256Hex(inputForHash);

    if (!force) {
      const [cacheRows] = await conn.query(
        `SELECT id, eval_json, generated_at FROM hp_qa_eval
          WHERE post_id = ? AND status = 1 AND llm_input_hash = ?
          ORDER BY generated_at DESC LIMIT 1`,
        [id, inputHash],
      );
      const cached = (cacheRows as any[])[0];
      if (cached) {
        await conn.query(
          `INSERT INTO hp_llm_log (route, entity_type, entity_id, model, latency_ms, cache_hit)
           VALUES (?, 'qa_eval', ?, 'cache', ?, 1)`,
          [route, cached.id, Date.now() - t0],
        );
        return c.json({ eval: JSON.parse(cached.eval_json), cached: true, id: cached.id });
      }
    }

    // ── LLM 평가 ──────────────────────────────────────────
    let llmResult: any = {
      oneLiner: "",
      axes: [],
      overallVerdict: "",
      observation: undefined,
    };
    let generator: "db_only" | "hybrid" = "db_only";
    let llmModel: string | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let llmLatency: number | null = null;
    let costUsd: number | null = null;
    let llmError: string | null = null;

    if (!skipLlm && c.env.OPENAI_API_KEY) {
      try {
        // 1) 이미지 src 추출 + 절대 URL 변환. 응답 있으면 응답에서, 없으면 문의 본문에서.
        const imgPattern = /<img\s[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
        const respContent = String(resp?.content ?? "");
        const sourceForImgs = resp ? respContent : String(post.content ?? "");
        const rawImgs = [...sourceForImgs.matchAll(imgPattern)].map((m) => m[1]);
        const assetBase = c.env.PMS_ASSET_BASE || DEFAULT_PMS_ASSET_BASE;
        const toAbsolute = (u: string): string => pmsAbsoluteUrl(u, assetBase);
        const visionImgs = rawImgs.map(toAbsolute).slice(0, 8); // 비용/시간 보호 — 최대 8장

        // 1-b) 본문(inquiry) + 응답(reply) 양쪽에서 /data/ 자산 이미지 추출 → hp_image_asset 분석·저장
        const inquiryImgs = [...String(post.content ?? "").matchAll(imgPattern)].map((m) => ({
          src: m[1],
          source: "inquiry" as const,
        }));
        const replyImgs = resp
          ? [...respContent.matchAll(imgPattern)].map((m) => ({ src: m[1], source: "reply" as const }))
          : [];
        const dataAssets = [...inquiryImgs, ...replyImgs].filter(({ src }) =>
          /^(\.\.\/|\.\/|\/)?data\//i.test(src),
        );
        if (dataAssets.length > 0) {
          await Promise.allSettled(
            dataAssets.slice(0, 16).map(({ src, source }) =>
              analyzeAndStoreImage(conn, c.env, {
                srcPath: src,
                absoluteUrl: toAbsolute(src),
                postId: id,
                projectId: post.project_id,
                source,
              }),
            ),
          );
        }

        // 2) 같은 프로젝트의 활성 표준답변 일부를 컨텍스트로 첨부
        //    런타임 PII 게이트(D): pii_text_status='blocked' 답변은 비노출,
        //    image_pii_status 미검수/의심 답변은 본문 <img> 제거 후 텍스트만 첨부.
        const [saRows] = await conn.query(
          `SELECT label, question, answer, pii_text_status, image_pii_status
             FROM hp_standard_answer
            WHERE status = 1 AND project_id = ?
              AND pii_text_status <> 'blocked'
            ORDER BY updated_at DESC, id DESC
            LIMIT 5`,
          [post.project_id],
        );
        const standardAnswers = (saRows as any[])
          .map((r) => {
            const gated = gateAnswerForRuntime(String(r.answer ?? ""), r.pii_text_status, r.image_pii_status);
            if (gated == null) return null; // 텍스트 차단 — 비노출
            return {
              label: r.label ?? "",
              question: r.question ?? "",
              answer: gated.slice(0, 2000),
            };
          })
          .filter((x): x is { label: string; question: string; answer: string } => x !== null);

        const userMsgParts = resp
          ? [
              `프로젝트: ${projectName}`,
              `문의자: ${meta.inquirer.name} (${inquirerKind})`,
              `응답자: ${meta.responder.name} (직원)`,
              `문의 시각: ${meta.inquiryAt}`,
              `응답 시각: ${meta.responseAt}`,
              `FRT: ${frt}`,
              "",
              "=== 문의 제목 ===",
              post.subject,
              "",
              "=== 문의 본문 ===",
              (post.content ?? "").slice(0, 6000),
              "",
              "=== 첫 직원 응답 (HTML 원본) ===",
              respContent.slice(0, 10000),
              "",
              visionImgs.length > 0
                ? `=== 첨부 이미지 (${visionImgs.length}장) ===\n아래 image_url로 같이 첨부됨. 첨부 순서대로 [이미지1], [이미지2] … 로 지칭.\n각 이미지의 실제 화면 내용(메뉴/버튼/필드명)을 시각적으로 파악하고, templates 답변에 캡션과 함께 배치하라.\n${visionImgs.map((s, i) => `[이미지${i + 1}] ${s}`).join("\n")}`
                : "(원본에 이미지 없음 — templates에 <img> 넣지 말 것)",
            ]
          : [
              // ── 답변이 아직 없는 문의 — 추천 답변 6개 생성 모드 ──
              `프로젝트: ${projectName}`,
              `문의자: ${meta.inquirer.name} (${inquirerKind})`,
              `문의 시각: ${meta.inquiryAt}`,
              `상태: 아직 답변이 등록되지 않은 문의 — 상담사가 보낼 후보 답변을 6개 작성하라.`,
              "",
              "=== 문의 제목 ===",
              post.subject,
              "",
              "=== 문의 본문 ===",
              (post.content ?? "").slice(0, 6000),
              "",
              visionImgs.length > 0
                ? `=== 문의 첨부 이미지 (${visionImgs.length}장) ===\n${visionImgs.map((s, i) => `[이미지${i + 1}] ${s}`).join("\n")}`
                : "(문의에 이미지 없음)",
            ];

        if (standardAnswers.length > 0) {
          userMsgParts.push(
            "",
            `=== 관련 표준답변 (${standardAnswers.length}건, 이 프로젝트의 활성 표준답변) — 톤·구조 참고용. 본문 복붙 금지 ===`,
            ...standardAnswers.map((sa, i) =>
              `[표준답변${i + 1}] ${sa.label}${sa.question ? ` / Q: ${sa.question}` : ""}\n${sa.answer}`,
            ),
          );
        }

        const userMsg = userMsgParts.join("\n");
        const llm = await callOpenAiJson<typeof llmResult>(c.env, {
          model: c.env.LLM_MODEL_PREMIUM, // openai/gpt-4.1-mini
          system: resp ? QA_SYSTEM_PROMPT : QA_INQUIRY_ONLY_SYSTEM_PROMPT,
          user: userMsg,
          images: visionImgs,
          maxTokens: 8000,
          temperature: 0.3,
          timeoutMs: 60_000,
        });
        llmResult = llm.data;
        generator = resp ? "hybrid" : "inquiry_only";
        llmModel = llm.model;
        promptTokens = llm.promptTokens;
        completionTokens = llm.completionTokens;
        llmLatency = llm.latencyMs;
        costUsd = llm.costUsd;
      } catch (e) {
        llmError = (e as Error).message;
      }
    }

    // overallAverage 계산
    const numericScores = (llmResult.axes ?? [])
      .map((a: any) => (typeof a.score === "number" ? a.score : null))
      .filter((s: any) => s !== null) as number[];
    const overallAverage =
      numericScores.length > 0
        ? Math.round((numericScores.reduce((a, b) => a + b, 0) / numericScores.length) * 10) / 10
        : 0;

    const qaEval = {
      meta,
      inquiry: post.content ?? "",
      response: resp?.content ?? "",
      oneLiner: llmResult.oneLiner ?? "",
      axes: llmResult.axes ?? [],
      overallAverage,
      overallVerdict: llmResult.overallVerdict ?? "",
      observation: llmResult.observation,
    };

    const totalLatency = Date.now() - t0;
    const [ins] = await conn.query(
      `INSERT INTO hp_qa_eval
         (post_id, project_id, generated_at, generator, llm_model, llm_input_hash,
          prompt_tokens, completion_tokens, latency_ms,
          eval_json, overall_score, overall_verdict)
       VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        post.project_id,
        generator,
        llmModel,
        inputHash,
        promptTokens,
        completionTokens,
        totalLatency,
        JSON.stringify(qaEval),
        overallAverage > 0 ? overallAverage : null,
        qaEval.overallVerdict ? qaEval.overallVerdict.slice(0, 100) : null, // 컬럼 VARCHAR(100) 안전 trim
      ],
    );
    const insertId = (ins as any).insertId as number;

    await conn.query(
      `INSERT INTO hp_llm_log
         (route, entity_type, entity_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd, cache_hit, error)
       VALUES (?, 'qa_eval', ?, ?, ?, ?, ?, ?, 0, ?)`,
      [route, insertId, llmModel ?? "db_only", promptTokens, completionTokens, llmLatency ?? totalLatency, costUsd, llmError],
    );

    return c.json({ eval: qaEval, cached: false, id: insertId, generator, llmError });
  }),
);

app.get("/pms/posts/:id/evals", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
    const [rows] = await conn.query(
      `SELECT id, generated_at, generator, llm_model, overall_score, overall_verdict, latency_ms
         FROM hp_qa_eval
        WHERE post_id = ? AND status = 1
     ORDER BY generated_at DESC LIMIT ${limit}`,
      [id],
    );
    return c.json({ rows });
  }),
);

app.get("/pms/evals/:id", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const [rows] = await conn.query(
      `SELECT id, post_id, project_id, generated_at, generator, llm_model, eval_json, overall_score, overall_verdict
         FROM hp_qa_eval WHERE id = ? AND status = 1`,
      [id],
    );
    const r = (rows as any[])[0];
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({
      id: r.id,
      postId: r.post_id,
      projectId: r.project_id,
      generatedAt: r.generated_at,
      generator: r.generator,
      llmModel: r.llm_model,
      eval: JSON.parse(r.eval_json),
    });
  }),
);

app.delete("/pms/evals/:id", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    await conn.query(`UPDATE hp_qa_eval SET status = -1 WHERE id = ?`, [id]);
    return c.json({ ok: true });
  }),
);

// ── 표준답변 후보 자동 추출 (LLM) ────────────────────────
// 프로젝트의 직원 응답 본문을 모아 LLM이 반복 패턴을 표준답변 후보로 정리.
// 저장은 별도 — UI에서 후보 검토 후 POST /standard-answers 호출.

app.post("/pms/projects/:id/standard-answer-suggestions", requireAuth, requireServiceToken, rateLimitLlm, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const force = c.req.query("force") === "1";
    const t0 = Date.now();
    const route = `POST /pms/projects/${id}/standard-answer-suggestions`;

    if (!c.env.OPENAI_API_KEY) {
      return c.json({ error: "LLM not configured" }, 503);
    }

    // 입력: 비공개 제외 staff 응답 본문 (최근, 짧은 것 제외)
    const [rows] = await conn.query(
      `SELECT c.content, p.subject AS post_subject
         FROM tb_post_comment c
         JOIN tb_post p ON p.id = c.post_id
         JOIN tb_user u ON u.id = c.user_id
        WHERE p.project_id = ? AND c.status = 1
          AND (u.email LIKE '%@malgnsoft.com' OR u.company = '맑은소프트')
          AND c.private_yn != 'Y'
          AND c.content IS NOT NULL AND CHAR_LENGTH(c.content) >= 30
     ORDER BY c.reg_date DESC LIMIT 50`,
      [id],
    );
    const messages = (rows as any[])
      .map((r) => ({
        subject: String(r.post_subject ?? "").trim(),
        content: String(r.content ?? "").replace(/\s+/g, " ").slice(0, 600),
      }))
      .filter((m) => m.content.length >= 30);

    if (messages.length < 5) {
      return c.json({
        suggestions: [],
        sampleSize: messages.length,
        note: "직원 응답이 5건 미만 — 표준답변 후보를 추출하기 어렵습니다.",
      });
    }

    // 캐시 키: messages 본문 해시
    const hashInput = JSON.stringify(messages.map((m) => m.content.slice(0, 200)));
    const inputHash = await sha256Hex(hashInput);

    if (!force) {
      // hp_briefing/hp_qa_eval 캐시와 분리 — entity_type = 'sa_suggest'로 hp_llm_log 검색.
      // 단순화: hp_briefing/qa_eval처럼 별도 테이블 없이, hp_llm_log에 결과 저장은 안 함.
      // 캐시는 in-flight 미적용 — 후보 추출은 가끔 트리거되므로 매번 새로 호출.
      // (필요 시 hp_sa_suggestion 신설하여 캐싱·재사용 가능)
    }

    let llm;
    try {
      llm = await callOpenAiJson<{
        suggestions: Array<{
          label: string;
          question: string;
          answer: string;
          frequency: number;
        }>;
      }>(c.env, {
        system: [
          "You analyze Korean customer support staff replies and extract recurring answer patterns as standard answer candidates.",
          "Inputs: an array of staff reply messages.",
          "Output strict JSON:",
          '{ "suggestions": [',
          '    { "label": "<짧은 한국어 라벨, 4단어 이내>",',
          '      "question": "<고객 입장에서 예상 질문, 1문장>",',
          '      "answer": "<직원 응답들의 공통 패턴을 일반화한 답변, 100~300자>",',
          '      "frequency": <이 패턴에 해당하는 추정 건수, int> }, ...',
          "]}",
          "규칙: 3~8개 후보. 진짜 반복되는 패턴만 (1~2건이면 제외).",
          "answer는 특정 회사명·고객명·날짜 등 인스턴스 정보 제외, 일반화. label은 의미 분류용.",
        ].join("\n"),
        user: [
          "다음은 한 프로젝트의 직원 응답 본문 목록입니다. 자주 반복되는 답변 패턴을 표준답변 후보로 추출해 주세요.",
          "",
          ...messages.map((m, i) => `[${i + 1}] (${m.subject})\n${m.content}`),
        ].join("\n\n"),
        maxTokens: 1500,
        temperature: 0.3,
      });
    } catch (e) {
      await conn.query(
        `INSERT INTO hp_llm_log (route, entity_type, entity_id, model, latency_ms, cache_hit, error)
         VALUES (?, 'sa_suggest', ?, 'openai/gpt-4o-mini', ?, 0, ?)`,
        [route, id, Date.now() - t0, (e as Error).message],
      );
      return c.json({ error: (e as Error).message }, 502);
    }

    const totalLatency = Date.now() - t0;
    await conn.query(
      `INSERT INTO hp_llm_log
         (route, entity_type, entity_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd, cache_hit)
       VALUES (?, 'sa_suggest', ?, ?, ?, ?, ?, ?, 0)`,
      [route, id, llm.model, llm.promptTokens, llm.completionTokens, llm.latencyMs, llm.costUsd],
    );

    return c.json({
      suggestions: (llm.data.suggestions ?? []).slice(0, 8).map((s) => ({
        label: String(s.label ?? "").slice(0, 100),
        question: String(s.question ?? "").slice(0, 500),
        answer: String(s.answer ?? "").slice(0, 1500),
        frequency: Number(s.frequency ?? 0),
      })),
      sampleSize: messages.length,
      inputHash,
      llm: {
        model: llm.model,
        promptTokens: llm.promptTokens,
        completionTokens: llm.completionTokens,
        latencyMs: llm.latencyMs,
        costUsd: llm.costUsd,
      },
    });
  }),
);

// ── /admin/evals — Q&A 평가 목록·정렬·필터 ────────────────
// 가드: 운영 데이터(평가 점수·게시글) → developer 이상. admin UI(qa-evals.vue)만 소비.
app.get("/admin/evals", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const projectId = c.req.query("projectId");
    const minScore = c.req.query("minScore");
    const maxScore = c.req.query("maxScore");
    const hasScore = c.req.query("hasScore") === "1";
    const sort = c.req.query("sort") ?? "recent"; // recent | score_asc | score_desc | latency

    // 기본: LLM 성공한 평가만 노출 (db_only 폴백·빈 결과는 카드를 못 열어서 무의미).
    // 명시적으로 includeEmpty=1 주면 전체 노출 (디버그·운영용).
    const includeEmpty = c.req.query("includeEmpty") === "1";
    const where: string[] = ["e.status = 1"];
    const params: any[] = [];
    if (!includeEmpty) {
      where.push("e.generator = 'hybrid'");
      where.push("e.overall_score IS NOT NULL");
    }
    if (projectId) {
      where.push("e.project_id = ?");
      params.push(parseInt(projectId, 10));
    }
    if (minScore) {
      where.push("e.overall_score >= ?");
      params.push(parseFloat(minScore));
    }
    if (maxScore) {
      where.push("e.overall_score <= ?");
      params.push(parseFloat(maxScore));
    }
    if (hasScore) where.push("e.overall_score IS NOT NULL");
    const whereSql = `WHERE ${where.join(" AND ")}`;

    let orderSql = "e.generated_at DESC, e.id DESC";
    if (sort === "score_asc") orderSql = "IFNULL(e.overall_score, 999) ASC, e.generated_at DESC";
    else if (sort === "score_desc") orderSql = "e.overall_score DESC, e.generated_at DESC";
    else if (sort === "latency") orderSql = "e.latency_ms DESC";

    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM hp_qa_eval e ${whereSql}`,
      params,
    );
    const total = Number((countRows as any[])[0]?.total ?? 0);

    const [rows] = await conn.query(
      `SELECT e.id, e.post_id, e.project_id, e.generated_at, e.generator, e.llm_model,
              e.overall_score, e.overall_verdict, e.latency_ms,
              p.subject AS post_subject,
              pj.name AS project_name, pj.group_id,
              g.name AS group_name
         FROM hp_qa_eval e
    LEFT JOIN tb_post p ON p.id = e.post_id
    LEFT JOIN tb_project pj ON pj.id = e.project_id
    LEFT JOIN tb_project_group g ON g.id = pj.group_id AND g.status = 1
        ${whereSql}
     ORDER BY ${orderSql}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    return c.json({
      total,
      limit,
      offset,
      sort,
      rows: (rows as any[]).map((r) => ({
        id: Number(r.id),
        postId: Number(r.post_id),
        projectId: Number(r.project_id),
        generatedAt: r.generated_at,
        generator: r.generator,
        llmModel: r.llm_model,
        overallScore: r.overall_score != null ? Number(r.overall_score) : null,
        overallVerdict: r.overall_verdict,
        latencyMs: r.latency_ms,
        postSubject: r.post_subject,
        projectName: r.project_name,
        groupId: r.group_id != null ? Number(r.group_id) : null,
        groupName: r.group_name ?? null,
      })),
    });
  }),
);

// ── /admin/cost — LLM 호출 비용·지연·실패 대시보드 데이터 ───
// 가드: 비용·감사 데이터 → developer 이상. admin UI(cost.vue)만 소비.
app.get("/admin/cost", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "30", 10) || 30, 1), 365);
    const recentLimit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);

    const since = `DATE_SUB(NOW(), INTERVAL ${days} DAY)`;

    // 전체 요약
    const [sumRows] = await conn.query(
      `SELECT COUNT(*) AS calls,
              SUM(cache_hit) AS cache_hits,
              SUM(IFNULL(prompt_tokens, 0)) AS prompt_tokens,
              SUM(IFNULL(completion_tokens, 0)) AS completion_tokens,
              SUM(IFNULL(cost_usd, 0)) AS cost_usd,
              AVG(latency_ms) AS avg_latency_ms,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
         FROM hp_llm_log
        WHERE request_at >= ${since}`,
    );
    const s = (sumRows as any[])[0];
    const summary = {
      calls: Number(s.calls ?? 0),
      cacheHits: Number(s.cache_hits ?? 0),
      promptTokens: Number(s.prompt_tokens ?? 0),
      completionTokens: Number(s.completion_tokens ?? 0),
      totalCostUsd: Number(s.cost_usd ?? 0),
      avgLatencyMs: s.avg_latency_ms != null ? Math.round(Number(s.avg_latency_ms)) : null,
      errors: Number(s.errors ?? 0),
    };

    // 모델별
    const [modelRows] = await conn.query(
      `SELECT model,
              COUNT(*) AS calls,
              SUM(cache_hit) AS cache_hits,
              SUM(IFNULL(prompt_tokens, 0)) AS prompt_tokens,
              SUM(IFNULL(completion_tokens, 0)) AS completion_tokens,
              SUM(IFNULL(cost_usd, 0)) AS cost_usd,
              AVG(latency_ms) AS avg_latency_ms,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
         FROM hp_llm_log
        WHERE request_at >= ${since}
     GROUP BY model
     ORDER BY calls DESC`,
    );

    // 엔티티 타입별
    const [entityRows] = await conn.query(
      `SELECT entity_type AS entity,
              COUNT(*) AS calls,
              SUM(IFNULL(cost_usd, 0)) AS cost_usd
         FROM hp_llm_log
        WHERE request_at >= ${since}
     GROUP BY entity_type
     ORDER BY calls DESC`,
    );

    // 일별
    const [dayRows] = await conn.query(
      `SELECT DATE(request_at) AS d,
              COUNT(*) AS calls,
              SUM(cache_hit) AS cache_hits,
              SUM(IFNULL(cost_usd, 0)) AS cost_usd,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
         FROM hp_llm_log
        WHERE request_at >= ${since}
     GROUP BY DATE(request_at)
     ORDER BY d ASC`,
    );

    // 최근 호출 N건
    const [recentRows] = await conn.query(
      `SELECT id, request_at, route, entity_type, entity_id, model,
              prompt_tokens, completion_tokens, latency_ms, cost_usd, cache_hit, error
         FROM hp_llm_log
        WHERE request_at >= ${since}
     ORDER BY id DESC
        LIMIT ${recentLimit}`,
    );

    return c.json({
      range: { days, since: null },
      summary,
      byModel: (modelRows as any[]).map((r) => ({
        model: r.model,
        calls: Number(r.calls),
        cacheHits: Number(r.cache_hits ?? 0),
        promptTokens: Number(r.prompt_tokens ?? 0),
        completionTokens: Number(r.completion_tokens ?? 0),
        costUsd: Number(r.cost_usd ?? 0),
        avgLatencyMs: r.avg_latency_ms != null ? Math.round(Number(r.avg_latency_ms)) : null,
        errors: Number(r.errors ?? 0),
      })),
      byEntity: (entityRows as any[]).map((r) => ({
        entity: r.entity,
        calls: Number(r.calls),
        costUsd: Number(r.cost_usd ?? 0),
      })),
      byDay: (dayRows as any[]).map((r) => ({
        date: String(r.d).slice(0, 10),
        calls: Number(r.calls),
        cacheHits: Number(r.cache_hits ?? 0),
        costUsd: Number(r.cost_usd ?? 0),
        errors: Number(r.errors ?? 0),
      })),
      recent: (recentRows as any[]).map((r) => ({
        id: Number(r.id),
        requestAt: r.request_at,
        route: r.route,
        entityType: r.entity_type,
        entityId: r.entity_id,
        model: r.model,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        latencyMs: r.latency_ms,
        costUsd: r.cost_usd != null ? Number(r.cost_usd) : null,
        cacheHit: Number(r.cache_hit) === 1,
        error: r.error,
      })),
    });
  }),
);

// ── 표준답변 큐레이션 공통 헬퍼 (분류·승인·중복) ───────────
// 정본: malgn-helper-mng/docs/STANDARD-ANSWER-CURATION.md (§2 분류 · §3 전이 · §4 중복/병합)
// 003 마이그레이션(운영 적용 완료)이 추가한 컬럼:
//   scope(common|service)·topic_id·service_id·tags(LONGTEXT JSON)·approval_status
//   ·approved_by·approved_at·rejection_reason·merged_into_id·source_uncovered_id

// ── graceful degrade: 신규/006 컬럼 존재 여부 캐시 ─────────────────
// 운영 MySQL에 마이그레이션이 아직 미적용일 수 있다.
// isolate 단위 lazy init — 첫 요청 시 INFORMATION_SCHEMA 조회 후 모듈 레벨 Map에 캐싱.
// 키: `${table}.${column}`, 값: boolean.
// ⚠ Worker isolate 수명 동안 캐시 유지 — 마이그레이션 적용 후 worker 재배포로 갱신.

const _colCache = new Map<string, boolean>();
let _colCacheInitialized = false;

/** 컬럼 존재 여부를 반환. 첫 호출에서 일괄 조회·캐싱. */
async function hasCol(conn: Queryable, table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  if (_colCacheInitialized) return _colCache.get(key) ?? false;
  // 첫 호출 — 007(last_verified_at·archived_reason·supersedes_id·superseded_by_id) +
  //           006(pii_text_status·image_pii_status·private_source_flag) 대상 컬럼 일괄 조회.
  const targets: Array<[string, string]> = [
    ["hp_standard_answer", "last_verified_at"],
    ["hp_standard_answer", "archived_reason"],
    ["hp_standard_answer", "supersedes_id"],
    ["hp_standard_answer", "superseded_by_id"],
    ["hp_standard_answer", "pii_text_status"],
    ["hp_standard_answer", "image_pii_status"],
    ["hp_standard_answer", "private_source_flag"],
    ["hp_announce", "last_verified_at"],
    ["hp_announce", "archived_reason"],
    ["hp_announce", "supersedes_id"],
    ["hp_announce", "superseded_by_id"],
    ["hp_announce", "pii_text_status"],
    ["hp_announce", "image_pii_status"],
    ["hp_announce", "private_source_flag"],
  ];
  // 초기값 false 세팅(쿼리 실패 시에도 graceful).
  for (const [t, c] of targets) _colCache.set(`${t}.${c}`, false);
  try {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME, COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('hp_standard_answer','hp_announce')
          AND COLUMN_NAME IN (
            'last_verified_at','archived_reason','supersedes_id','superseded_by_id',
            'pii_text_status','image_pii_status','private_source_flag'
          )`,
    );
    for (const r of rows as { TABLE_NAME: string; COLUMN_NAME: string }[]) {
      _colCache.set(`${r.TABLE_NAME}.${r.COLUMN_NAME}`, true);
    }
  } catch {
    // INFORMATION_SCHEMA 조회 실패 시 모두 false — 워커는 SQL 에러 없이 동작.
  }
  _colCacheInitialized = true;
  return _colCache.get(key) ?? false;
}

type SaScope = "common" | "service";
type SaApproval = "draft" | "reviewing" | "approved" | "rejected" | "archived";
const SA_APPROVALS: readonly SaApproval[] = ["draft", "reviewing", "approved", "rejected", "archived"];

/** §3-3 전이표 — from → 허용 to 집합. 위반 시 422. */
const SA_TRANSITIONS: Record<SaApproval, SaApproval[]> = {
  draft: ["reviewing", "rejected"],
  reviewing: ["approved", "rejected"],
  approved: ["archived"],
  rejected: ["draft"],
  archived: ["reviewing"],
};

// ── PII 게이트 공통 (006 마이그레이션) ─────────────────────
// 정본: malgn-helper-mng/docs/HP-SCHEMA.md (PII 게이트) + migrations/006_pii_gate.sql
//   텍스트 자동 스캔(B) · 비공개 출처 경고(B) · 런타임 롤업 게이트(D)에서 공유.
//   ⛔ PII 값 자체는 절대 로그·응답에 출력하지 않는다 — 유형/영역/건수만.
type PiiTextStatus = "pending" | "clear" | "masked" | "blocked";
type ImagePiiStatus = "none" | "pending" | "suspect" | "clear" | "removed" | "masked" | "blocked";

/** 런타임 노출 허용 이미지 상태(D). 이 집합 밖이면 답변 이미지 미노출. */
const IMAGE_PII_VIEWABLE: readonly ImagePiiStatus[] = ["none", "clear", "removed", "masked"];

/** hp_setting(safety).pii_patterns(JSON 문자열 배열) → 컴파일된 정규식 목록. 잘못된 패턴은 건너뜀. */
async function loadPiiPatterns(conn: Queryable): Promise<RegExp[]> {
  const [rows] = await conn.query(
    `SELECT setting_value FROM hp_setting WHERE group_name = 'safety' AND setting_key = 'pii_patterns' AND status = 1 LIMIT 1`,
  );
  const raw = (rows as { setting_value: string | null }[])[0]?.setting_value;
  if (!raw) return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out: RegExp[] = [];
  for (const p of list) {
    if (typeof p !== "string" || !p) continue;
    try { out.push(new RegExp(p, "g")); } catch { /* 잘못된 정규식 무시 */ }
  }
  return out;
}

/**
 * 본문 텍스트 PII 스캔(B). pii_patterns 중 하나라도 매칭되면 hit.
 * ⛔ 매칭된 PII 값(group)은 반환하지 않는다 — 매칭 패턴 인덱스·건수만 집계.
 * 반환: { hit, matchedPatterns(패턴 인덱스 배열), totalMatches }.
 */
function scanTextPii(text: string, patterns: RegExp[]): { hit: boolean; matchedPatterns: number[]; totalMatches: number } {
  const body = String(text ?? "");
  const matchedPatterns: number[] = [];
  let totalMatches = 0;
  patterns.forEach((re, idx) => {
    re.lastIndex = 0; // global 정규식 재사용 시 상태 초기화
    const m = body.match(re);
    if (m && m.length > 0) {
      matchedPatterns.push(idx);
      totalMatches += m.length;
    }
  });
  return { hit: matchedPatterns.length > 0, matchedPatterns, totalMatches };
}

/**
 * 비공개 출처 경고 산정(B). source_post_id 가 가리키는 원글에
 * 공개(staff) 답변이 없고 비공개(private_yn='Y') staff 답변만 존재하면 1.
 * (tb_post 자체엔 비공개 플래그가 없다 — 정본 LEGACY-DB-INVENTORY §4. 비공개 신호는 tb_post_comment.private_yn.)
 * ⛔ tb_* SELECT 전용. 비공개 본문은 읽지 않는다(존재 여부 카운트만).
 */
async function computePrivateSourceFlag(conn: Queryable, sourcePostId: number | null): Promise<0 | 1> {
  if (!sourcePostId || sourcePostId <= 0) return 0;
  const [rows] = await conn.query(
    `SELECT
       SUM(CASE WHEN c.private_yn != 'Y' THEN 1 ELSE 0 END) AS public_staff,
       SUM(CASE WHEN c.private_yn  = 'Y' THEN 1 ELSE 0 END) AS private_staff
     FROM tb_post_comment c
     JOIN tb_user cu ON cu.id = c.user_id
     WHERE c.post_id = ? AND c.status = 1
       AND (cu.email LIKE '%@malgnsoft.com' OR cu.company = '맑은소프트')
       AND c.content IS NOT NULL AND c.content != ''`,
    [sourcePostId],
  );
  const r = (rows as { public_staff: number | null; private_staff: number | null }[])[0];
  const pub = Number(r?.public_staff ?? 0);
  const priv = Number(r?.private_staff ?? 0);
  return pub === 0 && priv > 0 ? 1 : 0;
}

/**
 * 승인(reviewing→approved) 전이 직전 텍스트 PII 게이트(B).
 * 대상 테이블('hp_standard_answer'|'hp_announce')의 본문(answer|body)을 스캔.
 *  - 고유식별정보 등 발견 → pii_text_status='blocked' 기록 + 승인 거부(블록).
 *  - 통과 → pii_text_status='clear'.
 *  - 비공개 출처 → private_source_flag=1(경고, 비차단).
 * 반환: { blocked, matchedCount } — blocked면 호출부가 422 로 승인 차단.
 * ⛔ PII 값 미반환(매칭 건수만).
 */
async function applyTextPiiGate(
  conn: Queryable,
  table: "hp_standard_answer" | "hp_announce",
  id: number,
): Promise<{ blocked: boolean; matchedCount: number; privateSource: 0 | 1 }> {
  const bodyCol = table === "hp_standard_answer" ? "answer" : "body";
  const [rows] = await conn.query(
    `SELECT ${bodyCol} AS body, source_post_id FROM ${table} WHERE id = ? AND status = 1`,
    [id],
  );
  const row = (rows as { body: string | null; source_post_id: number | null }[])[0];
  if (!row) return { blocked: false, matchedCount: 0, privateSource: 0 };

  const patterns = await loadPiiPatterns(conn);
  const scan = scanTextPii(row.body ?? "", patterns);
  const privateSource = await computePrivateSourceFlag(conn, row.source_post_id ?? null);

  if (scan.hit) {
    // 차단: 본문에 PII 패턴 발견 → blocked 기록(승인 불가).
    await conn.query(
      `UPDATE ${table} SET pii_text_status = 'blocked', private_source_flag = ? WHERE id = ?`,
      [privateSource, id],
    );
    return { blocked: true, matchedCount: scan.totalMatches, privateSource };
  }
  // 통과: clear 기록(+ 비공개 출처 경고는 그대로 기록).
  await conn.query(
    `UPDATE ${table} SET pii_text_status = 'clear', private_source_flag = ? WHERE id = ?`,
    [privateSource, id],
  );
  return { blocked: false, matchedCount: 0, privateSource };
}

/**
 * 본문(answer|body) 변경 시 PII 게이트 재평가(H-1). PATCH 에서 본문이 바뀐 직후 호출.
 *  1. 텍스트 재스캔 — 변경 본문에 PII 패턴 발견 → pii_text_status='blocked', 아니면 'clear'.
 *     private_source_flag 도 재산정(source_post_id 기준).
 *  2. 이미지 상태 리셋 — 본문에 <img 있으면 image_pii_status='pending'(기존 확정 clear/removed/masked
 *     여도 본문이 바뀌었으니 재검수), 없으면 'none'. pii_checked_by/at 은 NULL 초기화.
 *  3. 승인 강등 — 현재 approval_status='approved' 면 'reviewing' 으로 강등(재승인 시 게이트 재통과 유도).
 * ⛔ PII 값 미반환·미로그(상태/건수만). UPDATE 대상은 hp_* 만.
 */
async function reevaluateGateOnBodyChange(
  conn: Queryable,
  table: "hp_standard_answer" | "hp_announce",
  id: number,
  newBody: string,
): Promise<void> {
  const patterns = await loadPiiPatterns(conn);
  const scan = scanTextPii(newBody ?? "", patterns);
  const piiTextStatus: PiiTextStatus = scan.hit ? "blocked" : "clear";

  // private_source_flag 재산정 — 현재 행의 source_post_id 로.
  const [srcRows] = await conn.query(
    `SELECT source_post_id, approval_status FROM ${table} WHERE id = ? AND status = 1`,
    [id],
  );
  const srcRow = (srcRows as { source_post_id: number | null; approval_status: SaApproval }[])[0];
  if (!srcRow) return;
  const privateSource = await computePrivateSourceFlag(conn, srcRow.source_post_id ?? null);

  // 이미지 상태 리셋 — 본문에 <img 존재 여부로 pending|none. checked_by/at NULL 초기화.
  const hasImg = /<img\b/i.test(newBody ?? "");
  const imagePiiStatus: ImagePiiStatus = hasImg ? "pending" : "none";

  const sets = [
    "pii_text_status = ?",
    "private_source_flag = ?",
    "image_pii_status = ?",
    "pii_checked_by = NULL",
    "pii_checked_at = NULL",
  ];
  const params: unknown[] = [piiTextStatus, privateSource, imagePiiStatus];

  // 승인 강등 — approved 였으면 reviewing 으로(재승인 시 게이트 재통과).
  if (srcRow.approval_status === "approved") {
    sets.push("approval_status = ?");
    params.push("reviewing" satisfies SaApproval);
  }

  params.push(id);
  await conn.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ? AND status = 1`, params);
}

/**
 * 이미지 PII 하드 게이트(M-1) — approved 전이 직전 호출. 본문에 <img 가 있고
 * image_pii_status 가 노출 허용 집합(none|clear|removed|masked) 밖(=pending|suspect|blocked)이면
 * 승인 차단 신호 반환. ⛔ PII 값·이미지 src 미노출(상태만).
 */
async function checkImageGate(
  conn: Queryable,
  table: "hp_standard_answer" | "hp_announce",
  id: number,
): Promise<{ blocked: boolean; imagePiiStatus: ImagePiiStatus }> {
  const bodyCol = table === "hp_standard_answer" ? "answer" : "body";
  const [rows] = await conn.query(
    `SELECT ${bodyCol} AS body, image_pii_status FROM ${table} WHERE id = ? AND status = 1`,
    [id],
  );
  const row = (rows as { body: string | null; image_pii_status: ImagePiiStatus }[])[0];
  if (!row) return { blocked: false, imagePiiStatus: "none" };
  const hasImg = /<img\b/i.test(row.body ?? "");
  const status = (row.image_pii_status ?? "none") as ImagePiiStatus;
  // 이미지 없으면 게이트 무관. 이미지 있고 노출 허용 집합 밖이면 차단.
  const blocked = hasImg && !IMAGE_PII_VIEWABLE.includes(status);
  return { blocked, imagePiiStatus: status };
}

/** 본문 HTML 에서 <img ...> 태그를 제거(런타임 게이트 D — 미검수/의심 이미지 미노출). 캡션 placeholder 로 치환. */
function stripImgTags(html: string): string {
  return String(html ?? "").replace(/<img\b[^>]*>/gi, "[이미지 검수 대기 — 미노출]");
}

/**
 * 런타임 노출 게이트(D) — 추천/검색/챗봇 등 답변 노출 직전 한 줄 게이트.
 *  - pii_text_status='blocked' → 답변 자체 비노출(null 반환).
 *  - image_pii_status ∉ {none,clear,removed,masked} → 답변 본문의 <img> 만 제거(텍스트는 유지).
 * 답변 단위 롤업(인용 이미지 중 최악값은 image_pii_status 컬럼이 이미 보유 — 호출부가 컬럼값 전달).
 */
function gateAnswerForRuntime(
  answer: string,
  piiTextStatus: PiiTextStatus | string | null,
  imagePiiStatus: ImagePiiStatus | string | null,
): string | null {
  if (piiTextStatus === "blocked") return null; // 텍스트 차단 → 답변 비노출
  const imgOk = IMAGE_PII_VIEWABLE.includes((imagePiiStatus ?? "none") as ImagePiiStatus);
  return imgOk ? answer : stripImgTags(answer);
}

/** tags(LONGTEXT) 역직렬화 — NULL/빈문자/비배열은 [] 로 정규화. */
function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 입력 tags 검증·직렬화 — 배열 아니면 null(미지정), 빈배열은 "[]". 문자열 요소만 허용. */
function serializeTags(input: unknown): string | null {
  if (input == null) return null;
  if (!Array.isArray(input)) return undefined as unknown as null; // 호출부에서 400 처리
  const arr = input.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  return JSON.stringify(arr);
}

/** hp_topic 존재·active 검증. 반환: ok면 scope 동반, 아니면 사유. */
async function validateTopic(
  conn: Queryable,
  topicId: number,
): Promise<{ ok: true; scope: SaScope } | { ok: false; reason: string }> {
  const [rows] = await conn.query(
    `SELECT id, scope, active FROM hp_topic WHERE id = ? AND status = 1`,
    [topicId],
  );
  const r = (rows as { scope: SaScope; active: number }[])[0];
  if (!r) return { ok: false, reason: "topic not found" };
  if (r.active !== 1) return { ok: false, reason: "topic inactive" };
  return { ok: true, scope: r.scope };
}

/** hp_service 존재·active 검증. */
async function validateService(
  conn: Queryable,
  serviceId: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [rows] = await conn.query(
    `SELECT id, active FROM hp_service WHERE id = ? AND status = 1`,
    [serviceId],
  );
  const r = (rows as { active: number }[])[0];
  if (!r) return { ok: false, reason: "service not found" };
  if (r.active !== 1) return { ok: false, reason: "service inactive" };
  return { ok: true };
}

type SaSimilar = {
  id: number;
  label: string;
  question: string;
  scope: SaScope;
  topicId: number | null;
  serviceId: number | null;
  approvalStatus: SaApproval;
  usageCount: number;
  score: number; // 토큰 자카드 유사도 0~1 (MVP)
};

/**
 * 질문 유사 표준답변 top N.
 * OpenSearch k-NN 전환 대상(§4-1, T2) — 현재는 인프라 부재로 LIKE+토큰 자카드 MVP.
 * 1) 질문에서 2글자 이상 토큰 추출 → LIKE 후보 수집(topic/service 동일 우선)
 * 2) 후보별 토큰 자카드 계산 → 임계 이상만 점수순 top N.
 */
async function findSimilarStandardAnswers(
  conn: Queryable,
  args: { question: string; topicId?: number | null; serviceId?: number | null; excludeId?: number; limit?: number },
): Promise<SaSimilar[]> {
  const question = (args.question ?? "").trim();
  if (!question) return [];
  const limit = args.limit ?? 5;
  // 한국어 짧은 키워드: 공백/구두점 분리 후 2글자 이상 토큰만.
  const tokens = Array.from(
    new Set(question.toLowerCase().split(/[\s,.!?·…"'()[\]{}<>/\\|:;~`@#$%^&*+=\-]+/u).filter((t) => t.length >= 2)),
  );
  if (!tokens.length) return [];

  const where: string[] = ["status = 1"];
  // 런타임 PII 게이트(D): 텍스트 차단(blocked) 답변은 추천/매칭 후보에서 제외.
  where.push("pii_text_status <> 'blocked'");
  const params: unknown[] = [];
  if (args.excludeId != null) {
    where.push("id <> ?");
    params.push(args.excludeId);
  }
  // 토큰 LIKE OR (최대 8개로 제한해 쿼리 폭증 방지)
  const likeTokens = tokens.slice(0, 8);
  where.push(`(${likeTokens.map(() => "question LIKE ?").join(" OR ")})`);
  for (const t of likeTokens) params.push(`%${t}%`);

  const [rows] = await conn.query(
    `SELECT id, label, question, scope, topic_id, service_id, approval_status, usage_count
       FROM hp_standard_answer
      WHERE ${where.join(" AND ")}
      LIMIT 200`,
    params,
  );

  const qSet = new Set(tokens);
  const scored: SaSimilar[] = [];
  for (const r of rows as {
    id: number; label: string; question: string; scope: SaScope;
    topic_id: number | null; service_id: number | null;
    approval_status: SaApproval; usage_count: number;
  }[]) {
    const cTokens = new Set(
      (r.question ?? "").toLowerCase().split(/[\s,.!?·…"'()[\]{}<>/\\|:;~`@#$%^&*+=\-]+/u).filter((t) => t.length >= 2),
    );
    if (!cTokens.size) continue;
    let inter = 0;
    for (const t of qSet) if (cTokens.has(t)) inter++;
    const union = qSet.size + cTokens.size - inter;
    let score = union > 0 ? inter / union : 0;
    // 같은 topic/service면 가중(분류 일치 신호) — §4-1 "동일 topic_id+키워드 다수 일치"
    if (args.topicId != null && r.topic_id === args.topicId) score += 0.1;
    if (args.serviceId != null && r.service_id === args.serviceId) score += 0.05;
    if (score < 0.3) continue; // MVP 임계(자카드 0.6은 토큰 적을 때 과엄격 → 0.3 + 분류가중). T2에서 재튜닝.
    scored.push({
      id: r.id,
      label: r.label,
      question: r.question,
      scope: r.scope,
      topicId: r.topic_id,
      serviceId: r.service_id,
      approvalStatus: r.approval_status,
      usageCount: Number(r.usage_count ?? 0),
      score: Math.min(1, Number(score.toFixed(3))),
    });
  }
  scored.sort((a, b) => b.score - a.score || b.usageCount - a.usageCount);
  return scored.slice(0, limit);
}

// ── 표준답변 임베딩 색인(Vectorize: malgn-helper-sa-vectors) ──────────────────
// 어휘 자카드 MVP 대비 의역·유사표현 강건. SA 1건 = 벡터 1개(청크 불필요).
// 임베딩 대상 = label + "\n" + question(질문 중심; answer는 길어 제외). bge-m3(1024-dim cosine, 자료 RAG와 동일 모델).
const SA_EMBED_MODEL = "@cf/baai/bge-m3"; // 자료(VECTORIZE)와 동일 모델·차원(1024) 일치.
const SA_EMBED_TEXT_MAX = 2000; // 임베딩 입력 문자 상한(질문이 매우 길면 앞부분만).
// 백필 일회용 엔드포인트 가드 — 원문 토큰의 SHA-256(원문은 호출자 별도 보유). 코드엔 해시만.
const SA_BACKFILL_TOKEN_HASH = "564a2240a928642f5e2389dcadacff9b1c445e0c73f728fb034dda4a34b9f0ba";

/** SA 임베딩·색인·필터에 필요한 최소 행 형상(라이브 조회 결과 매핑). */
type SaVectorRow = {
  id: number;
  label: string;
  question: string;
  scope: SaScope;
  serviceId: number | null;
  topicId: number | null;
};

/** VECTORIZE_SA 바인딩 가용 여부 — 미바인딩/런타임 미주입 시 안전 스킵. */
function vectorizeSaAvailable(env: Bindings): boolean {
  const v = env.VECTORIZE_SA as unknown as
    | { query?: unknown; upsert?: unknown; deleteByIds?: unknown }
    | undefined;
  return (
    !!v &&
    typeof v.upsert === "function" &&
    typeof v.query === "function" &&
    typeof v.deleteByIds === "function"
  );
}

/** SA 벡터 id — sa-{id}. deleteByIds 로 단건 정리. */
function saVectorId(id: number): string {
  return `sa-${id}`;
}

/** 임베딩 입력 텍스트(label + question, 상한 절단). */
function saEmbedText(label: string, question: string): string {
  return `${label ?? ""}\n${question ?? ""}`.trim().slice(0, SA_EMBED_TEXT_MAX);
}

/** hex 문자열 상수시간 비교(토큰 해시 검증 — 타이밍 누출 방지). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * 표준답변 1건 임베딩 → VECTORIZE_SA upsert(id=sa-{id}). metadata: saId·scope·serviceId·topicId·label.
 * Vectorize 미가용/임베딩·색인 실패는 try/catch 로 삼킴(색인 실패해도 본 흐름 진행, console.warn).
 * metadata 는 Vectorize 제약상 string|number|boolean 만 — serviceId/topicId 는 null→0 으로 정규화.
 */
async function indexStandardAnswerVector(env: Bindings, saRow: SaVectorRow): Promise<void> {
  if (!vectorizeSaAvailable(env)) return;
  try {
    const text = saEmbedText(saRow.label, saRow.question);
    if (!text) return;
    const out = (await env.AI.run(SA_EMBED_MODEL, { text: [text] })) as unknown as { data?: number[][] };
    const values = out?.data?.[0];
    if (!Array.isArray(values) || values.length === 0) throw new Error("임베딩 결과 없음");
    await env.VECTORIZE_SA.upsert([
      {
        id: saVectorId(saRow.id),
        values,
        metadata: {
          saId: saRow.id,
          scope: saRow.scope,
          serviceId: saRow.serviceId ?? 0,
          topicId: saRow.topicId ?? 0,
          label: (saRow.label ?? "").slice(0, 200),
        },
      },
    ]);
  } catch (e) {
    console.warn(`[sa ${saRow.id}] 벡터 색인 실패: ${(e as Error).message}`.slice(0, 300));
  }
}

/** 표준답변 벡터 제거(sa-{id}). 미가용/실패는 무시(로깅). */
async function removeStandardAnswerVector(env: Bindings, id: number): Promise<void> {
  if (!vectorizeSaAvailable(env)) return;
  try {
    await env.VECTORIZE_SA.deleteByIds([saVectorId(id)]);
  } catch (e) {
    console.warn(`[sa ${id}] 벡터 삭제 실패: ${(e as Error).message}`.slice(0, 300));
  }
}

/** id 로 SA 벡터행 로드(라이프사이클 색인용). status/approval 무관 조회 — 색인 여부는 호출부 판단. */
async function loadSaVectorRow(conn: Queryable, id: number): Promise<SaVectorRow | null> {
  const [rows] = await conn.query(
    `SELECT id, label, question, scope, service_id, topic_id FROM hp_standard_answer WHERE id = ? LIMIT 1`,
    [id],
  );
  const r = (rows as Array<{
    id: number; label: string; question: string; scope: SaScope;
    service_id: number | null; topic_id: number | null;
  }>)[0];
  if (!r) return null;
  return { id: r.id, label: r.label, question: r.question, scope: r.scope, serviceId: r.service_id, topicId: r.topic_id };
}

// ── 표준 답변 카탈로그 (hp_standard_answer) ────────────
// QaEvalCard "표준답변으로 저장" 액션의 destination + 챗봇 응답 1순위 소스.
//
// 가드 방침 (소비자 분석 결과):
//  - POST: malgn-helper-pms 임베드가 "표준답변으로 저장"에서 호출.
//    보안 백로그 #1 — requireServiceToken(X-Service-Token) 적용.
//    PMS는 Nitro 프록시 경유(브라우저에 토큰 노출 금지). 점진 전환 플래그로 회귀 방지.
//  - GET(목록·상세): admin UI(standard-answers.vue, credentials 전송)만 소비.
//    카탈로그 전량 노출 방지 → developer 이상으로 보호.
//  - PATCH/DELETE: 파괴적 변경 → admin. admin UI가 credentials 전송 중.
app.post("/standard-answers", requireServiceToken, async (c) =>
  withConn(c, async (conn) => {
    const body = await c.req.json<{
      label?: string;
      question?: string;
      answer?: string;
      projectId?: number | null;
      sourcePostId?: number | null;
      sourceAxis?: string | null;
      createdBy?: string | null;
      // 003 분류 (§2-1). 모두 선택 — 미지정이면 NULL(운영자가 admin에서 후분류).
      scope?: string | null;
      topicId?: number | null;
      serviceId?: number | null;
      tags?: unknown;
      // 007 버전 링크 — 의미 변경 new row 에 기록. 컬럼 없으면 무시(graceful degrade).
      supersedesId?: number | null;
    }>();
    const assetBase = c.env.PMS_ASSET_BASE || DEFAULT_PMS_ASSET_BASE;
    const label = (body.label ?? "").trim();
    // 이미지 경로(/data/..)를 도메인 포함 절대 URL로 정규화해 저장 — 정본이 어디서든 안 깨지게.
    const question = absolutizePmsAssets((body.question ?? "").trim(), assetBase);
    const answer = absolutizePmsAssets((body.answer ?? "").trim(), assetBase);
    if (!label || !question || !answer) {
      return c.json({ error: "label, question, answer required" }, 400);
    }
    if (label.length > 100) return c.json({ error: "label too long (<=100)" }, 400);
    if (question.length > 10000 || answer.length > 10000) {
      return c.json({ error: "question/answer too long (<=10000)" }, 400);
    }

    // 분류 검증 (§2-1). scope 미지정이면 'service' DB default 따름(컬럼 생략).
    let scope: SaScope | null = null;
    if (body.scope != null) {
      if (body.scope !== "common" && body.scope !== "service") {
        return c.json({ error: "scope must be common|service" }, 400);
      }
      scope = body.scope;
    }
    // topic_id / service_id 존재·active 검증 (FK 없음 → 앱 레벨, 규칙 준수).
    let topicId: number | null = null;
    if (body.topicId != null) {
      const tid = Number(body.topicId);
      if (!Number.isInteger(tid)) return c.json({ error: "invalid topicId" }, 400);
      const v = await validateTopic(conn, tid);
      if (!v.ok) return c.json({ error: v.reason }, 400);
      topicId = tid;
    }
    let serviceId: number | null = null;
    if (body.serviceId != null) {
      const sid = Number(body.serviceId);
      if (!Number.isInteger(sid)) return c.json({ error: "invalid serviceId" }, 400);
      const v = await validateService(conn, sid);
      if (!v.ok) return c.json({ error: v.reason }, 400);
      serviceId = sid;
    }
    // tags: 배열→JSON.stringify, 없으면 NULL. 비배열은 400.
    const tagsJson = serializeTags(body.tags);
    if (tagsJson === undefined) return c.json({ error: "tags must be an array of strings" }, 400);

    // 저장 직전 유사 표준답변 top N (중복 경고용, §4-1). OpenSearch k-NN 전환 대상(§4-1, T2).
    const similar = await findSimilarStandardAnswers(conn, { question, topicId, serviceId });

    // supersedes_id — 007 컬럼 있을 때만 INSERT에 포함(graceful degrade).
    const supersedesId: number | null = (body.supersedesId != null && Number.isInteger(Number(body.supersedesId)))
      ? Number(body.supersedesId) : null;
    const hasSupersedesCol = await hasCol(conn, "hp_standard_answer", "supersedes_id");
    const supersedesColPart = (hasSupersedesCol && supersedesId != null) ? "supersedes_id, " : "";
    const supersedesValPart = (hasSupersedesCol && supersedesId != null) ? "?, " : "";

    // 모든 수집 진입점은 항상 draft 로 진입 — 무검증 답변 챗봇 직행 방지 (§3-4).
    const [ins] = await conn.query(
      `INSERT INTO hp_standard_answer
         (label, question, answer, project_id, source_post_id, source_axis, created_by,
          ${scope != null ? "scope, " : ""}topic_id, service_id, tags, ${supersedesColPart}approval_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ${scope != null ? "?, " : ""}?, ?, ?, ${supersedesValPart}'draft')`,
      [
        label,
        question,
        answer,
        body.projectId ?? null,
        body.sourcePostId ?? null,
        body.sourceAxis ?? null,
        body.createdBy ?? null,
        ...(scope != null ? [scope] : []),
        topicId,
        serviceId,
        tagsJson,
        ...(hasSupersedesCol && supersedesId != null ? [supersedesId] : []),
      ],
    );
    return c.json(
      {
        ok: true,
        id: (ins as { insertId: number }).insertId,
        approvalStatus: "draft",
        similar,
        ...(hasSupersedesCol && supersedesId != null ? { supersedesId } : {}),
      },
      201,
    );
  }),
);

// 목록 + 검색 (LIKE 기반 — 한국어 짧은 키워드 호환). FULLTEXT는 향후 ngram parser 도입 시 전환.
// 필터(§9-B): scope / topicId / serviceId / approvalStatus / search. topic·service slug/name LEFT JOIN.
app.get("/standard-answers", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    // search(신규) 우선, 없으면 기존 q 호환.
    const q = (c.req.query("search") ?? c.req.query("q") ?? "").trim();
    const projectId = c.req.query("projectId");
    const scopeQ = c.req.query("scope");
    const topicIdQ = c.req.query("topicId");
    const serviceIdQ = c.req.query("serviceId");
    const approvalQ = c.req.query("approvalStatus");
    // needsVerification=true: 007 컬럼 있을 때 재검증 필요 행 필터(§8-1, §10-3).
    const needsVerification = c.req.query("needsVerification") === "true";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const sortQ = c.req.query("sort"); // updated | created | usage(기본)

    const where: string[] = ["sa.status = 1"];
    const params: unknown[] = [];
    if (projectId) {
      // 해당 프로젝트 전용 + 전사 공통(NULL) 모두 포함
      where.push("(sa.project_id = ? OR sa.project_id IS NULL)");
      params.push(parseInt(projectId, 10));
    }
    if (scopeQ === "common" || scopeQ === "service") {
      where.push("sa.scope = ?");
      params.push(scopeQ);
    }
    if (topicIdQ) {
      where.push("sa.topic_id = ?");
      params.push(parseInt(topicIdQ, 10));
    }
    if (serviceIdQ) {
      where.push("sa.service_id = ?");
      params.push(parseInt(serviceIdQ, 10));
    }
    if (approvalQ && (SA_APPROVALS as readonly string[]).includes(approvalQ)) {
      where.push("sa.approval_status = ?");
      params.push(approvalQ);
    }
    if (q) {
      where.push("(sa.label LIKE ? OR sa.question LIKE ? OR sa.answer LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    // 재검증 필터(007 컬럼 있을 때만) — approved 이고 last_verified_at이 NULL 또는 180일 경과.
    const hasLastVerifiedCol = await hasCol(conn, "hp_standard_answer", "last_verified_at");
    if (needsVerification) {
      if (hasLastVerifiedCol) {
        where.push(
          "sa.approval_status = 'approved'" +
          " AND (sa.last_verified_at IS NULL OR sa.last_verified_at < NOW() - INTERVAL 180 DAY)",
        );
      } else {
        // 컬럼 없으면 빈 결과 반환(graceful degrade).
        return c.json({ total: 0, limit, offset, rows: [], needsVerificationSkipped: true });
      }
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM hp_standard_answer sa ${whereSql}`,
      params,
    );
    const total = Number((countRows as { total: number }[])[0]?.total ?? 0);

    // 정렬: sort 파라미터(updated=수정일/created=등록일/usage=사용순, 기본 usage).
    // updated_at NULL(미수정)은 created_at 으로 대체해 정렬. projectId 면 전용 우선.
    // sort = <field>[_<dir>] — field: updated(수정일)|created(등록일)|usage(사용순, 기본)|pii(PII 검수 우선), dir: desc(기본)|asc.
    // pii: image_pii_status 가 'suspect'(의심)·'pending'(미검수) 인 행을 최상단으로 끌어올려 검수 큐로 사용.
    //      dir 무관(우선순위 고정), 동순위는 usage_count 내림차순으로 안정 정렬.
    const sm = (sortQ ?? "usage").match(/^(updated|created|usage|pii)(?:_(asc|desc))?$/);
    const sField = sm ? sm[1] : "usage";
    const sDir = sm && sm[2] === "asc" ? "ASC" : "DESC";
    const SORT_COL: Record<string, string> = {
      updated: "COALESCE(sa.updated_at, sa.created_at)",
      created: "sa.created_at",
      usage: "sa.usage_count",
    };
    // PII 검수 우선순위: suspect(2) > pending(1) > 그 외(0) 내림차순.
    const PII_PRIORITY = "(CASE sa.image_pii_status WHEN 'suspect' THEN 2 WHEN 'pending' THEN 1 ELSE 0 END)";
    const order =
      (projectId ? "(sa.project_id IS NOT NULL) DESC, " : "") +
      (sField === "pii"
        ? `${PII_PRIORITY} DESC, sa.usage_count DESC, sa.id DESC`
        : `${SORT_COL[sField]} ${sDir}, sa.id ${sDir}`);

    // 007 신규 컬럼을 SELECT에 조건부 포함(graceful degrade).
    const hasSupersedesCol = await hasCol(conn, "hp_standard_answer", "supersedes_id");
    const hasSupersededByCol = await hasCol(conn, "hp_standard_answer", "superseded_by_id");
    const hasArchivedReasonCol = await hasCol(conn, "hp_standard_answer", "archived_reason");
    const extraCols007 = [
      ...(hasLastVerifiedCol ? ["sa.last_verified_at"] : []),
      ...(hasSupersedesCol ? ["sa.supersedes_id"] : []),
      ...(hasSupersededByCol ? ["sa.superseded_by_id"] : []),
      ...(hasArchivedReasonCol ? ["sa.archived_reason"] : []),
    ].join(", ");

    // 006 PII 컬럼 존재 여부(SELECT 조건부 포함).
    const hasPiiTextCol = await hasCol(conn, "hp_standard_answer", "pii_text_status");
    const hasImagePiiCol = await hasCol(conn, "hp_standard_answer", "image_pii_status");
    const hasPrivateSrcCol = await hasCol(conn, "hp_standard_answer", "private_source_flag");
    const extraCols006 = [
      ...(hasImagePiiCol ? ["sa.image_pii_status"] : []),
      ...(hasPiiTextCol ? ["sa.pii_text_status"] : []),
      ...(hasPrivateSrcCol ? ["sa.private_source_flag"] : []),
    ].join(", ");

    const extraColsSql = [extraCols006, extraCols007].filter(Boolean).join(", ");

    const [rows] = await conn.query(
      `SELECT sa.id, sa.label, sa.question, sa.answer, sa.project_id, sa.source_post_id, sa.source_axis,
              sa.created_by, sa.usage_count, sa.last_used_at, sa.created_at, sa.updated_at,
              sa.scope, sa.topic_id, sa.service_id, sa.tags, sa.approval_status,
              sa.approved_by, sa.approved_at, sa.rejection_reason, sa.merged_into_id, sa.source_uncovered_id
              ${extraColsSql ? ", " + extraColsSql : ""},
              t.slug AS topic_slug, t.label AS topic_label,
              s.slug AS service_slug, s.name AS service_name
         FROM hp_standard_answer sa
         LEFT JOIN hp_topic   t ON t.id = sa.topic_id   AND t.status = 1
         LEFT JOIN hp_service s ON s.id = sa.service_id AND s.status = 1
         ${whereSql}
     ORDER BY ${order}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    // tags(LONGTEXT) → 배열 역직렬화해 노출.
    const mapped = (rows as { tags: unknown }[]).map((r) => ({ ...r, tags: parseTags(r.tags) }));
    return c.json({ total, limit, offset, rows: mapped });
  }),
);

// 중복 감지 (§4-1) — 질문 유사 표준답변 top N.
// 정적 경로 → 파라미터 경로(`/:id`)보다 먼저 등록(라우트 가로채기 방지, 현행 관례).
// OpenSearch k-NN 전환 대상(§4-1, T2) — 현재는 LIKE+토큰 자카드 MVP.
app.post("/standard-answers/check-duplicate", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    type DupBody = { question?: string; topicId?: number | null; serviceId?: number | null; limit?: number };
    const body = await c.req.json<DupBody>().catch((): DupBody => ({}));
    const question = (body.question ?? "").trim();
    if (!question) return c.json({ error: "question required" }, 400);
    const limit = Math.min(Math.max(Number(body.limit ?? 5) || 5, 1), 20);
    const topicId = body.topicId != null && Number.isInteger(Number(body.topicId)) ? Number(body.topicId) : null;
    const serviceId = body.serviceId != null && Number.isInteger(Number(body.serviceId)) ? Number(body.serviceId) : null;
    const similar = await findSimilarStandardAnswers(conn, { question, topicId, serviceId, limit });
    return c.json({ similar });
  }),
);

app.get("/standard-answers/:id", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    // 007 컬럼 존재 여부 확인 후 SELECT에 조건부 포함(graceful degrade).
    // sa.* 는 이미 존재 컬럼만 반환하므로 SQL 에러는 없으나, 미적용 환경에서 응답 형상 일관성을 위해 null로 채움.
    const [hasLVA, hasSID, hasSBID, hasAR] = await Promise.all([
      hasCol(conn, "hp_standard_answer", "last_verified_at"),
      hasCol(conn, "hp_standard_answer", "supersedes_id"),
      hasCol(conn, "hp_standard_answer", "superseded_by_id"),
      hasCol(conn, "hp_standard_answer", "archived_reason"),
    ]);
    const [rows] = await conn.query(
      `SELECT sa.*, t.slug AS topic_slug, t.label AS topic_label,
              s.slug AS service_slug, s.name AS service_name
         FROM hp_standard_answer sa
         LEFT JOIN hp_topic   t ON t.id = sa.topic_id   AND t.status = 1
         LEFT JOIN hp_service s ON s.id = sa.service_id AND s.status = 1
        WHERE sa.id = ? AND sa.status = 1`,
      [id],
    );
    const r = (rows as Record<string, unknown>[])[0];
    if (!r) return c.json({ error: "not found" }, 404);
    // 007 컬럼이 DB에 없으면 응답에 null로 명시(admin 형상 일관성).
    return c.json({
      ...r,
      tags: parseTags(r.tags),
      last_verified_at: hasLVA ? (r.last_verified_at ?? null) : null,
      supersedes_id: hasSID ? (r.supersedes_id ?? null) : null,
      superseded_by_id: hasSBID ? (r.superseded_by_id ?? null) : null,
      archived_reason: hasAR ? (r.archived_reason ?? null) : null,
    });
  }),
);

app.patch("/standard-answers/:id", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json<{
      label?: string;
      question?: string;
      answer?: string;
      // 003 분류 — 기존 항목도 수정 가능 (§2-1). scope 는 NOT NULL ENUM, topic/service/tags 는 NULL 허용.
      scope?: string | null;
      topicId?: number | null;
      serviceId?: number | null;
      tags?: unknown;
    }>();
    const assetBase = c.env.PMS_ASSET_BASE || DEFAULT_PMS_ASSET_BASE;
    const sets: string[] = [];
    const params: any[] = [];
    // answer(본문) 변경 시 게이트 재평가(H-1) — 저장될 최종 본문을 보관.
    let newAnswer: string | null = null;
    // 본문 — question/answer 는 POST 와 동일하게 이미지 경로 절대화.
    for (const k of ["label", "question", "answer"] as const) {
      const v = body[k];
      if (v !== undefined) {
        let trimmed = String(v).trim();
        if (!trimmed) return c.json({ error: `${k} empty` }, 400);
        if (k === "question" || k === "answer") trimmed = absolutizePmsAssets(trimmed, assetBase);
        if (k === "answer") newAnswer = trimmed;
        sets.push(`${k} = ?`);
        params.push(trimmed);
      }
    }
    // 분류 — scope/topicId/serviceId/tags. 미지정(null/'')로 보내면 topic/service/tags 는 해제, scope 는 필수값이라 무시.
    if (body.scope !== undefined && body.scope !== null && body.scope !== "") {
      if (body.scope !== "common" && body.scope !== "service") {
        return c.json({ error: "scope must be common|service" }, 400);
      }
      sets.push("scope = ?");
      params.push(body.scope);
    }
    if (body.topicId !== undefined) {
      if (body.topicId === null) {
        sets.push("topic_id = ?");
        params.push(null);
      } else {
        const tid = Number(body.topicId);
        if (!Number.isInteger(tid)) return c.json({ error: "invalid topicId" }, 400);
        const v = await validateTopic(conn, tid);
        if (!v.ok) return c.json({ error: v.reason }, 400);
        sets.push("topic_id = ?");
        params.push(tid);
      }
    }
    if (body.serviceId !== undefined) {
      if (body.serviceId === null) {
        sets.push("service_id = ?");
        params.push(null);
      } else {
        const sid = Number(body.serviceId);
        if (!Number.isInteger(sid)) return c.json({ error: "invalid serviceId" }, 400);
        const v = await validateService(conn, sid);
        if (!v.ok) return c.json({ error: v.reason }, 400);
        sets.push("service_id = ?");
        params.push(sid);
      }
    }
    if (body.tags !== undefined) {
      const tagsJson = serializeTags(body.tags);
      if (tagsJson === undefined) return c.json({ error: "tags must be an array of strings" }, 400);
      sets.push("tags = ?");
      params.push(tagsJson);
    }
    if (!sets.length) return c.json({ error: "no fields" }, 400);
    params.push(id);
    const [result] = await conn.query(
      `UPDATE hp_standard_answer SET ${sets.join(", ")} WHERE id = ? AND status = 1`,
      params,
    );
    // H-1: answer(본문) 변경 시 PII 게이트 재평가 — 텍스트 재스캔·이미지 리셋·승인 강등.
    let gateReevaluated = false;
    if (newAnswer !== null) {
      await reevaluateGateOnBodyChange(conn, "hp_standard_answer", id, newAnswer);
      gateReevaluated = true;
    }
    // SA 임베딩 동기화 — 재평가 후 최종 상태 기준. approved 면 재색인, 아니면(강등 포함) 벡터 제거(idempotent).
    const finalRow = await loadSaVectorRow(conn, id);
    if (finalRow) {
      const [statRows] = await conn.query(
        `SELECT approval_status FROM hp_standard_answer WHERE id = ? AND status = 1 LIMIT 1`,
        [id],
      );
      const approvalNow = (statRows as Array<{ approval_status: SaApproval }>)[0]?.approval_status ?? null;
      if (approvalNow === "approved") await indexStandardAnswerVector(c.env, finalRow);
      else await removeStandardAnswerVector(c.env, id);
    }
    return c.json({ ok: true, affected: (result as any).affectedRows, changed: (result as any).changedRows, gateReevaluated });
  }),
);

app.delete("/standard-answers/:id", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    await conn.query(
      `UPDATE hp_standard_answer SET status = -1 WHERE id = ?`,
      [id],
    );
    // soft-delete → SA 벡터 제거(매칭 후보에서 즉시 배제).
    await removeStandardAnswerVector(c.env, id);
    return c.json({ ok: true });
  }),
);

// 챗봇이 답변을 사용했을 때 usage_count 증가용 (Phase 2 챗봇 도입 시 호출)
app.post("/standard-answers/:id/use", requireServiceToken, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    await conn.query(
      `UPDATE hp_standard_answer
          SET usage_count = usage_count + 1, last_used_at = NOW()
        WHERE id = ? AND status = 1`,
      [id],
    );
    return c.json({ ok: true });
  }),
);

// 승인 워크플로 상태 전이 (§3-2/§3-3). body { to, reason?, archivedReason? }.
// 전이표(SA_TRANSITIONS) 위반 시 422. approved 시 approved_by(세션)·approved_at=NOW().
// rejected 시 rejection_reason 필수. 가드 developer↑ (승인/반려/보관/검토착수/재작업/복원 모두).
//   - 정본 §3-3 은 draft→reviewing(검토착수)을 agent(자기 제안)도 허용하나,
//     현 가드 체계엔 "본인 제안" 판별이 없어 우선 developer↑ 로 통일(보고: 확인 필요).
// reviewing→approved 자동 게이트(§10-3):
//   (A) 분류 게이트: scope='service' 인데 service_id IS NULL → 422 ERR_CLASSIFY
//   (B) PII 게이트(006 컬럼 있을 때): pii_text_status='blocked' 또는 이미지 차단 → 422 ERR_PII
//   통과 시 응답에 gate:{classification,pii} 포함.
// reviewing→approved + supersedes_id 있을 때 원자적 버전 교체(007 컬럼 있을 때):
//   신규 row approved + 구본 archived (동일 트랜잭션).
// approved→archived: archivedReason 입력 수용(007 컬럼 있을 때).
app.patch("/standard-answers/:id/transition", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    type TransBody = { to?: string; reason?: string; archivedReason?: string };
    const body = await c.req.json<TransBody>().catch((): TransBody => ({}));
    const to = body.to;
    if (!to || !(SA_APPROVALS as readonly string[]).includes(to)) {
      return c.json({ error: "to must be one of draft|reviewing|approved|rejected|archived" }, 400);
    }
    const target = to as SaApproval;

    // 007 컬럼 존재 여부 사전 확인(graceful degrade).
    const [hasSupersedesCol, hasSupersededByCol, hasArchivedReasonCol, hasLastVerifiedCol] = await Promise.all([
      hasCol(conn, "hp_standard_answer", "supersedes_id"),
      hasCol(conn, "hp_standard_answer", "superseded_by_id"),
      hasCol(conn, "hp_standard_answer", "archived_reason"),
      hasCol(conn, "hp_standard_answer", "last_verified_at"),
    ]);
    // 006 PII 컬럼 존재 여부.
    const [hasPiiTextCol, hasImagePiiCol] = await Promise.all([
      hasCol(conn, "hp_standard_answer", "pii_text_status"),
      hasCol(conn, "hp_standard_answer", "image_pii_status"),
    ]);

    // 현재 행 조회 — 분류 게이트에 필요한 scope·service_id·supersedes_id 포함.
    const selectCols = [
      "id", "approval_status", "scope", "service_id",
      ...(hasSupersedesCol ? ["supersedes_id"] : []),
    ].join(", ");
    const [rows] = await conn.query(
      `SELECT ${selectCols} FROM hp_standard_answer WHERE id = ? AND status = 1`,
      [id],
    );
    const cur = (rows as {
      approval_status: SaApproval;
      scope: SaScope;
      service_id: number | null;
      supersedes_id?: number | null;
    }[])[0];
    if (!cur) return c.json({ error: "not found" }, 404);
    const from = cur.approval_status;
    // SA 벡터 라이프사이클용 — from 이 이후 target 상관 흐름분석으로 좁혀지기 전 여기서 확정.
    const wasApproved = from === "approved";

    // 전이 유효성 (§3-3 전이표). 같은 상태로의 no-op도 위반으로 막는다.
    if (!SA_TRANSITIONS[from]?.includes(target)) {
      return c.json({ error: `invalid transition: ${from} -> ${target}`, from, allowed: SA_TRANSITIONS[from] ?? [] }, 422);
    }

    const reason = (body.reason ?? "").trim();
    if (target === "rejected" && !reason) {
      return c.json({ error: "rejection_reason required for rejected (§3-4)" }, 400);
    }

    // ── reviewing→approved 자동 게이트 ──
    // gate 결과 요약(admin UI 표시용). 컬럼 미적용 환경에서도 형상 일관성 유지.
    type GateResult = "pass" | "fail" | "skip";
    const gate: { classification: GateResult; pii: GateResult } = {
      classification: "pass",
      pii: "skip",
    };

    if (target === "approved" && from === "reviewing") {
      // (A) 분류 게이트: scope='service' 인데 service_id IS NULL → ERR_CLASSIFY 422.
      //     기존 컬럼(scope·service_id) — 항상 적용.
      if (cur.scope === "service" && cur.service_id == null) {
        gate.classification = "fail";
        return c.json({
          error: "분류 게이트: scope=service 인데 service_id 가 지정되지 않았습니다.",
          code: "ERR_CLASSIFY",
          failed: ["classification"],
          gate,
        }, 422);
      }

      // (B) PII 게이트(006 컬럼 있을 때만).
      if (hasPiiTextCol || hasImagePiiCol) {
        // 텍스트 PII 게이트(B): 본문 스캔. 컬럼 없으면 skip.
        if (hasPiiTextCol) {
          const textGate = await applyTextPiiGate(conn, "hp_standard_answer", id);
          if (textGate.blocked) {
            gate.pii = "fail";
            return c.json({
              error: "PII 게이트: 본문에서 고유식별정보 패턴이 발견되어 승인할 수 없습니다. 마스킹 후 재시도하세요.",
              code: "ERR_PII",
              failed: ["pii"],
              piiTextStatus: "blocked",
              matchedCount: textGate.matchedCount,
              privateSource: textGate.privateSource === 1,
              gate: { ...gate, pii: "fail" },
            }, 422);
          }
        }
        // 이미지 PII 하드 게이트(M-1): 이미지 보유 + 미검수/의심/차단 → 승인 거부.
        if (hasImagePiiCol) {
          const imgGate = await checkImageGate(conn, "hp_standard_answer", id);
          if (imgGate.blocked) {
            gate.pii = "fail";
            return c.json({
              error: "PII 게이트: 인용 이미지 검수가 완료되지 않아 승인할 수 없습니다. 이미지 검수(clear/removed/masked) 후 재시도하세요.",
              code: "ERR_PII",
              failed: ["pii"],
              imagePiiStatus: imgGate.imagePiiStatus,
              gate: { ...gate, pii: "fail" },
            }, 422);
          }
        }
        gate.pii = "pass";
      }
      // (else) 006 컬럼 없으면 pii: 'skip' 유지.
    } else if (target === "approved") {
      // reviewing 외 다른 상태에서 approved 로 가는 전이는 전이표에서 막히므로 여기 도달 안 함.
      // 방어 코드: 분류 게이트만 실행.
      if (cur.scope === "service" && cur.service_id == null) {
        gate.classification = "fail";
        return c.json({
          error: "분류 게이트: scope=service 인데 service_id 가 지정되지 않았습니다.",
          code: "ERR_CLASSIFY",
          failed: ["classification"],
          gate,
        }, 422);
      }
    }

    // ── 원자적 버전 교체(reviewing→approved + supersedes_id 있을 때, 007 컬럼 있을 때) ──
    const supersedesId: number | null = hasSupersedesCol ? (cur.supersedes_id ?? null) : null;
    const doVersionSwap = target === "approved" && from === "reviewing" && supersedesId != null
      && hasSupersedesCol && hasSupersededByCol && hasArchivedReasonCol;

    const approver = c.get("session").email ?? null;

    if (doVersionSwap) {
      // 단일 트랜잭션 — 신규본 approved + 구본 archived 원자적.
      await (conn as { beginTransaction(): Promise<void> }).beginTransaction();
      try {
        // 신규본: approved + approved_by/at + last_verified_at(컬럼 있을 때).
        const newSets: string[] = ["approval_status = 'approved'", "approved_by = ?", "approved_at = NOW()"];
        const newParams: unknown[] = [approver];
        if (hasLastVerifiedCol) newSets.push("last_verified_at = NOW()");
        newParams.push(id);
        await conn.query(
          `UPDATE hp_standard_answer SET ${newSets.join(", ")} WHERE id = ? AND status = 1`,
          newParams,
        );
        // 구본: archived + archived_reason='superseded' + superseded_by_id=신규 id.
        const oldSets: string[] = [
          "approval_status = 'archived'",
          "archived_reason = 'superseded'",
          "superseded_by_id = ?",
        ];
        const oldParams: unknown[] = [id, supersedesId];
        await conn.query(
          `UPDATE hp_standard_answer SET ${oldSets.join(", ")} WHERE id = ? AND status = 1`,
          oldParams,
        );
        await (conn as { commit(): Promise<void> }).commit();
      } catch (txErr) {
        await (conn as { rollback(): Promise<void> }).rollback();
        throw txErr;
      }
      // SA 임베딩 동기화: 신규본(approved) 색인 + 구본(archived) 벡터 제거.
      const newRow = await loadSaVectorRow(conn, id);
      if (newRow) await indexStandardAnswerVector(c.env, newRow);
      await removeStandardAnswerVector(c.env, supersedesId);
      return c.json({ ok: true, id, from, to: target, gate, supersededId: supersedesId });
    }

    // ── 일반 전이(버전 교체 없음) ──
    const sets: string[] = ["approval_status = ?"];
    const params: unknown[] = [target];
    if (target === "approved") {
      sets.push("approved_by = ?", "approved_at = NOW()");
      params.push(approver);
      if (hasLastVerifiedCol) sets.push("last_verified_at = NOW()");
    }
    if (target === "rejected") {
      sets.push("rejection_reason = ?", "approved_by = ?");
      params.push(reason, approver);
    }
    if (target === "archived") {
      // archivedReason 입력 수용(007 컬럼 있을 때). 값 허용: superseded|outdated|domain_closed.
      const archivedReasonInput = (body.archivedReason ?? "").trim();
      const VALID_AR = ["superseded", "outdated", "domain_closed"] as const;
      if (hasArchivedReasonCol && archivedReasonInput && (VALID_AR as readonly string[]).includes(archivedReasonInput)) {
        sets.push("archived_reason = ?");
        params.push(archivedReasonInput);
      }
    }
    params.push(id);
    await conn.query(
      `UPDATE hp_standard_answer SET ${sets.join(", ")} WHERE id = ? AND status = 1`,
      params,
    );
    // SA 임베딩 라이프사이클: reviewing→approved 성공 시 색인, approved 이탈(archived 등) 시 제거.
    if (target === "approved") {
      const row = await loadSaVectorRow(conn, id);
      if (row) await indexStandardAnswerVector(c.env, row);
    } else if (wasApproved) {
      // approved 이탈(archived 등) → 벡터 제거.
      await removeStandardAnswerVector(c.env, id);
    }
    return c.json({ ok: true, id, from, to: target, ...(target === "approved" ? { gate } : {}) });
  }),
);

// ── 백필: status=1·approved 표준답변 전수 임베딩·색인(VECTORIZE_SA) ─────────────
// 일회용 운영 엔드포인트 — 토큰 해시 가드(SA_BACKFILL_TOKEN_HASH). 원문 토큰은 호출자 보유.
//   가드: X-Migrate-Token 헤더 또는 Authorization: Bearer <token>. SHA-256(token) === 하드코딩 해시.
//   배치: ?limit=(1~200, 기본 100) &offset=(기본 0). id ASC 페이지네이션. 진행/누적 반환.
//   사용: 최초 offset=0 호출 → 응답 nextOffset 을 다음 호출 offset 으로. done=true 면 완료.
app.post("/admin/migrate/sa-vectors-backfill", async (c) =>
  withConn(c, async (conn) => {
    // ── 토큰 해시 가드 ──
    const auth = c.req.header("Authorization") || c.req.header("authorization") || "";
    const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
    const token = (c.req.header("X-Migrate-Token") || bearer || "").trim();
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const tokenHash = await sha256Hex(token);
    if (!timingSafeEqualHex(tokenHash, SA_BACKFILL_TOKEN_HASH)) return c.json({ error: "unauthorized" }, 401);

    if (!vectorizeSaAvailable(c.env)) return c.json({ error: "VECTORIZE_SA 미가용(바인딩 확인 필요)" }, 503);

    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

    // 대상 전수 카운트(진행률 표시용).
    const [cntRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM hp_standard_answer WHERE status = 1 AND approval_status = 'approved'`,
    );
    const total = Number((cntRows as Array<{ total: number | string }>)[0]?.total ?? 0);

    // 배치 조회(id ASC).
    const [rows] = await conn.query(
      `SELECT id, label, question, scope, service_id, topic_id
         FROM hp_standard_answer
        WHERE status = 1 AND approval_status = 'approved'
        ORDER BY id ASC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    const batch = rows as Array<{
      id: number; label: string; question: string; scope: SaScope;
      service_id: number | null; topic_id: number | null;
    }>;

    let indexed = 0;
    let failed = 0;
    if (batch.length > 0) {
      // 임베딩 — bge-m3 입력 배열 상한(100) 단위 분할.
      const texts = batch.map((r) => saEmbedText(r.label, r.question));
      const embeddings: (number[] | null)[] = new Array(batch.length).fill(null);
      const EMB_BATCH = 100;
      for (let s = 0; s < texts.length; s += EMB_BATCH) {
        const slice = texts.slice(s, s + EMB_BATCH);
        try {
          const out = (await c.env.AI.run(SA_EMBED_MODEL, { text: slice })) as unknown as { data?: number[][] };
          const emb = out?.data ?? [];
          for (let j = 0; j < slice.length; j++) {
            const v = emb[j];
            if (Array.isArray(v) && v.length > 0) embeddings[s + j] = v;
          }
        } catch (e) {
          console.warn(`[sa-backfill] 임베딩 배치 실패(offset ${offset + s}): ${(e as Error).message}`.slice(0, 300));
        }
      }
      // upsert 벡터 구성.
      const vectors: VectorizeVector[] = [];
      for (let i = 0; i < batch.length; i++) {
        const values = embeddings[i];
        const r = batch[i];
        if (!values) { failed++; continue; }
        vectors.push({
          id: saVectorId(r.id),
          values,
          metadata: {
            saId: r.id,
            scope: r.scope,
            serviceId: r.service_id ?? 0,
            topicId: r.topic_id ?? 0,
            label: (r.label ?? "").slice(0, 200),
          },
        });
      }
      if (vectors.length > 0) {
        try {
          await c.env.VECTORIZE_SA.upsert(vectors);
          indexed = vectors.length;
        } catch (e) {
          failed += vectors.length;
          return c.json({
            error: `Vectorize upsert 실패: ${(e as Error).message}`.slice(0, 300),
            batch: { limit, offset, count: batch.length },
            total,
          }, 502);
        }
      }
    }

    const processed = offset + batch.length;
    return c.json({
      ok: true,
      batch: { limit, offset, count: batch.length },
      indexed,
      failed,
      total,
      processed,
      nextOffset: processed,
      done: processed >= total || batch.length === 0,
    });
  }),
);

// 중복 병합 (§4-2) — secondary(:id) → primary(intoId).
//   secondary: status=-1 + merged_into_id=intoId, primary: usage_count 합산·last_used_at 최신·tags 합집합·출처 승계.
//   가드 admin (정본 §1-3 병합은 developer/admin — 보수적으로 admin 적용. 확인 필요).
app.post("/standard-answers/:id/merge", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const secondaryId = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(secondaryId) || secondaryId <= 0) return c.json({ error: "invalid id" }, 400);
    type MergeBody = { intoId?: number };
    const body = await c.req.json<MergeBody>().catch((): MergeBody => ({}));
    const primaryId = Number(body.intoId);
    if (!Number.isInteger(primaryId) || primaryId <= 0) return c.json({ error: "intoId required" }, 400);
    if (primaryId === secondaryId) return c.json({ error: "cannot merge into self" }, 400);

    // 두 행을 모두 잠금 조회(원자성은 단일 connection·순차 UPDATE로 충분 — 트래픽 소규모).
    const [rows] = await conn.query(
      `SELECT id, usage_count, last_used_at, tags, source_post_id, source_axis, project_id
         FROM hp_standard_answer
        WHERE id IN (?, ?) AND status = 1`,
      [primaryId, secondaryId],
    );
    const list = rows as {
      id: number; usage_count: number; last_used_at: string | null;
      tags: unknown; source_post_id: number | null; source_axis: string | null; project_id: number | null;
    }[];
    const primary = list.find((r) => r.id === primaryId);
    const secondary = list.find((r) => r.id === secondaryId);
    if (!primary) return c.json({ error: "primary(intoId) not found" }, 404);
    if (!secondary) return c.json({ error: "secondary(:id) not found" }, 404);

    // usage_count 합산 (채택 신호 손실 방지).
    const mergedUsage = Number(primary.usage_count ?? 0) + Number(secondary.usage_count ?? 0);
    // last_used_at: 더 최근 값.
    const mergedLastUsed =
      [primary.last_used_at, secondary.last_used_at]
        .filter((v): v is string => !!v)
        .sort()
        .pop() ?? null;
    // tags 합집합.
    const mergedTags = Array.from(new Set([...parseTags(primary.tags), ...parseTags(secondary.tags)]));
    // 출처: primary가 NULL이면 secondary 값 승계.
    const mergedSourcePost = primary.source_post_id ?? secondary.source_post_id ?? null;
    const mergedSourceAxis = primary.source_axis ?? secondary.source_axis ?? null;

    await conn.query(
      `UPDATE hp_standard_answer
          SET usage_count = ?, last_used_at = ?, tags = ?, source_post_id = ?, source_axis = ?
        WHERE id = ? AND status = 1`,
      [mergedUsage, mergedLastUsed, JSON.stringify(mergedTags), mergedSourcePost, mergedSourceAxis, primaryId],
    );
    // secondary soft-delete + merged_into_id 역추적 기록.
    await conn.query(
      `UPDATE hp_standard_answer SET status = -1, merged_into_id = ? WHERE id = ?`,
      [primaryId, secondaryId],
    );
    return c.json({ ok: true, primaryId, secondaryId, usageCount: mergedUsage });
  }),
);

// ── 표준 안내답변 (hp_announce) ───────────────────────
// 정본: malgn-helper-mng/docs/PMS-INQUIRY-HARVEST.md §5-3 (안내글 vs Q&A 분기 · 별도 테이블)
//        STANDARD-ANSWER-CURATION.md §2-1(분류 축) · §3(승인 워크플로 — SA 와 공유)
// 005 마이그레이션(운영 적용 완료)이 신설한 hp_announce:
//   title(NOT NULL)·label·question(NULL)·body(NOT NULL)·scope·topic_id·service_id·tags(LONGTEXT)
//   ·approval_status·approved_by·approved_at·rejection_reason·merged_into_id·source_uncovered_id
//   ·source_post_id·created_by·usage_count·last_used_at·status·created_at·updated_at
//
// SA(hp_standard_answer)와 동형 — 분류·승인 라이프사이클·전이표(SA_TRANSITIONS)·tags 직렬화를 그대로 공유한다.
// 다른 점: 질문(question) 대신 title 이 식별자(질문 NULL 허용), 본문은 body(NOT NULL).
//   admin 의 SA UI 재사용을 위해 조회 응답에서 body 를 answer 로도 매핑한다(body↔answer 동형 처리).
//
// 가드 방침 (SA 와 동일):
//  - GET(목록·상세): developer↑ (카탈로그 전량 노출 방지).
//  - POST: requireServiceToken (PMS 임베드가 "표준 안내답변으로 저장"에서 호출. 항상 draft).
//  - PATCH(본문 수정)·DELETE: admin (파괴적 변경).
//  - PATCH /:id/transition: developer↑ (SA 전이표·권한 재사용).

/** hp_topic 존재·active 검증 (announce 용 — SA validateTopic 과 동일 시그니처, scope 동반). */
// (validateTopic / validateService / parseTags / serializeTags / SA_TRANSITIONS / SA_APPROVALS 재사용)

// 목록 + 검색. 필터: scope / topicId / serviceId / approvalStatus / search.
// topic·service slug/label LEFT JOIN. tags 배열화. body→answer 매핑(admin SA UI 재사용).
app.get("/announces", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const q = (c.req.query("search") ?? c.req.query("q") ?? "").trim();
    const scopeQ = c.req.query("scope");
    const topicIdQ = c.req.query("topicId");
    const serviceIdQ = c.req.query("serviceId");
    const approvalQ = c.req.query("approvalStatus");
    const needsVerificationAn = c.req.query("needsVerification") === "true";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const sortQ = c.req.query("sort"); // usage(기본) | pii(PII 검수 우선)

    const where: string[] = ["an.status = 1"];
    const params: unknown[] = [];
    if (scopeQ === "common" || scopeQ === "service") {
      where.push("an.scope = ?");
      params.push(scopeQ);
    }
    if (topicIdQ) {
      where.push("an.topic_id = ?");
      params.push(parseInt(topicIdQ, 10));
    }
    if (serviceIdQ) {
      where.push("an.service_id = ?");
      params.push(parseInt(serviceIdQ, 10));
    }
    if (approvalQ && (SA_APPROVALS as readonly string[]).includes(approvalQ)) {
      where.push("an.approval_status = ?");
      params.push(approvalQ);
    }
    if (q) {
      // 안내글은 질문이 NULL 일 수 있어 title/label/body/question 을 모두 검색.
      where.push("(an.title LIKE ? OR an.label LIKE ? OR an.body LIKE ? OR an.question LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    // 재검증 필터(007 컬럼 있을 때만).
    const hasLastVerifiedColAnList = await hasCol(conn, "hp_announce", "last_verified_at");
    if (needsVerificationAn) {
      if (hasLastVerifiedColAnList) {
        where.push(
          "an.approval_status = 'approved'" +
          " AND (an.last_verified_at IS NULL OR an.last_verified_at < NOW() - INTERVAL 180 DAY)",
        );
      } else {
        return c.json({ total: 0, limit, offset, rows: [], needsVerificationSkipped: true });
      }
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM hp_announce an ${whereSql}`,
      params,
    );
    const total = Number((countRows as { total: number }[])[0]?.total ?? 0);

    // 007 신규 컬럼 조건부 SELECT.
    const hasAnSupersedesCol = await hasCol(conn, "hp_announce", "supersedes_id");
    const hasAnSupersededByCol = await hasCol(conn, "hp_announce", "superseded_by_id");
    const hasAnArchivedReasonCol = await hasCol(conn, "hp_announce", "archived_reason");
    const anExtra007 = [
      ...(hasLastVerifiedColAnList ? ["an.last_verified_at"] : []),
      ...(hasAnSupersedesCol ? ["an.supersedes_id"] : []),
      ...(hasAnSupersededByCol ? ["an.superseded_by_id"] : []),
      ...(hasAnArchivedReasonCol ? ["an.archived_reason"] : []),
    ].join(", ");

    // 006 PII 컬럼 조건부 SELECT.
    const hasAnPiiTextCol = await hasCol(conn, "hp_announce", "pii_text_status");
    const hasAnImagePiiCol = await hasCol(conn, "hp_announce", "image_pii_status");
    const hasAnPrivateSrcCol = await hasCol(conn, "hp_announce", "private_source_flag");
    const anExtra006 = [
      ...(hasAnImagePiiCol ? ["an.image_pii_status"] : []),
      ...(hasAnPiiTextCol ? ["an.pii_text_status"] : []),
      ...(hasAnPrivateSrcCol ? ["an.private_source_flag"] : []),
    ].join(", ");

    const anExtraColsSql = [anExtra006, anExtra007].filter(Boolean).join(", ");

    // 정렬: 기본은 사용순(usage). sort=pii 면 PII 검수 우선(suspect>pending>그 외) 후 사용순.
    // 006 컬럼 없으면 pii 정렬에서 image_pii_status 미참조(CASE 문 대신 단순 안정정렬).
    const annPiiOrder = hasAnImagePiiCol
      ? "(CASE an.image_pii_status WHEN 'suspect' THEN 2 WHEN 'pending' THEN 1 ELSE 0 END) DESC, an.usage_count DESC, an.created_at DESC"
      : "an.usage_count DESC, an.created_at DESC";
    const annOrder = sortQ === "pii" ? annPiiOrder : "an.usage_count DESC, an.created_at DESC";

    const [rows] = await conn.query(
      `SELECT an.id, an.title, an.label, an.question, an.body, an.scope, an.topic_id, an.service_id,
              an.tags, an.approval_status, an.approved_by, an.approved_at, an.rejection_reason,
              an.merged_into_id, an.source_uncovered_id, an.source_post_id, an.created_by,
              an.usage_count, an.last_used_at, an.created_at, an.updated_at
              ${anExtraColsSql ? ", " + anExtraColsSql : ""},
              t.slug AS topic_slug, t.label AS topic_label,
              s.slug AS service_slug, s.name AS service_name
         FROM hp_announce an
         LEFT JOIN hp_topic   t ON t.id = an.topic_id   AND t.status = 1
         LEFT JOIN hp_service s ON s.id = an.service_id AND s.status = 1
         ${whereSql}
     ORDER BY ${annOrder}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    // tags 배열화 + body→answer 매핑(admin SA UI 가 answer 필드를 그대로 소비).
    const mapped = (rows as { tags: unknown; body: string }[]).map((r) => ({
      ...r,
      tags: parseTags(r.tags),
      answer: r.body,
    }));
    return c.json({ total, limit, offset, rows: mapped });
  }),
);

app.get("/announces/:id", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    // 007 컬럼 존재 여부 확인 후 미적용 환경에서 null로 채워 응답 형상 일관성 유지.
    const [hasAnLVA, hasAnSID, hasAnSBID, hasAnAR] = await Promise.all([
      hasCol(conn, "hp_announce", "last_verified_at"),
      hasCol(conn, "hp_announce", "supersedes_id"),
      hasCol(conn, "hp_announce", "superseded_by_id"),
      hasCol(conn, "hp_announce", "archived_reason"),
    ]);
    const [rows] = await conn.query(
      `SELECT an.*, t.slug AS topic_slug, t.label AS topic_label,
              s.slug AS service_slug, s.name AS service_name
         FROM hp_announce an
         LEFT JOIN hp_topic   t ON t.id = an.topic_id   AND t.status = 1
         LEFT JOIN hp_service s ON s.id = an.service_id AND s.status = 1
        WHERE an.id = ? AND an.status = 1`,
      [id],
    );
    const r = (rows as Record<string, unknown>[])[0];
    if (!r) return c.json({ error: "not found" }, 404);
    // body→answer 매핑(SA UI 재사용) + 007 컬럼 null 채움.
    return c.json({
      ...r,
      tags: parseTags(r.tags),
      answer: r.body,
      last_verified_at: hasAnLVA ? (r.last_verified_at ?? null) : null,
      supersedes_id: hasAnSID ? (r.supersedes_id ?? null) : null,
      superseded_by_id: hasAnSBID ? (r.superseded_by_id ?? null) : null,
      archived_reason: hasAnAR ? (r.archived_reason ?? null) : null,
    });
  }),
);

// 저장 — 항상 draft. title/body 필수, question 선택. 이미지 절대화. SA POST 와 동일 가드.
app.post("/announces", requireServiceToken, async (c) =>
  withConn(c, async (conn) => {
    const body = await c.req.json<{
      title?: string;
      label?: string | null;
      question?: string | null;
      body?: string;
      // SA 호환: admin SA UI 가 answer 로 보낼 수 있어 body 별칭으로 수용.
      answer?: string;
      sourcePostId?: number | null;
      createdBy?: string | null;
      scope?: string | null;
      topicId?: number | null;
      serviceId?: number | null;
      tags?: unknown;
    }>();
    const assetBase = c.env.PMS_ASSET_BASE || DEFAULT_PMS_ASSET_BASE;
    const title = (body.title ?? "").trim();
    // 본문은 body 우선, 없으면 answer(SA UI 별칭). 이미지 경로 절대화.
    const rawBody = body.body ?? body.answer ?? "";
    const announceBody = absolutizePmsAssets(String(rawBody).trim(), assetBase);
    // question 은 선택 — 있으면 절대화, 없으면 NULL.
    const rawQuestion = (body.question ?? "").trim();
    const question = rawQuestion ? absolutizePmsAssets(rawQuestion, assetBase) : null;
    const label = (body.label ?? "").trim() || null;

    if (!title || !announceBody) {
      return c.json({ error: "title, body required" }, 400);
    }
    if (title.length > 150) return c.json({ error: "title too long (<=150)" }, 400);
    if (label && label.length > 100) return c.json({ error: "label too long (<=100)" }, 400);
    if (announceBody.length > 10000) return c.json({ error: "body too long (<=10000)" }, 400);
    if (question && question.length > 10000) return c.json({ error: "question too long (<=10000)" }, 400);

    // 분류 검증 (§2-1). scope 미지정이면 'service' DB default.
    let scope: SaScope | null = null;
    if (body.scope != null) {
      if (body.scope !== "common" && body.scope !== "service") {
        return c.json({ error: "scope must be common|service" }, 400);
      }
      scope = body.scope;
    }
    let topicId: number | null = null;
    if (body.topicId != null) {
      const tid = Number(body.topicId);
      if (!Number.isInteger(tid)) return c.json({ error: "invalid topicId" }, 400);
      const v = await validateTopic(conn, tid);
      if (!v.ok) return c.json({ error: v.reason }, 400);
      topicId = tid;
    }
    let serviceId: number | null = null;
    if (body.serviceId != null) {
      const sid = Number(body.serviceId);
      if (!Number.isInteger(sid)) return c.json({ error: "invalid serviceId" }, 400);
      const v = await validateService(conn, sid);
      if (!v.ok) return c.json({ error: v.reason }, 400);
      serviceId = sid;
    }
    const tagsJson = serializeTags(body.tags);
    if (tagsJson === undefined) return c.json({ error: "tags must be an array of strings" }, 400);

    // 항상 draft 로 진입 (무검증 안내문 챗봇 직행 방지, §3-4).
    const [ins] = await conn.query(
      `INSERT INTO hp_announce
         (title, label, question, body, source_post_id, created_by,
          ${scope != null ? "scope, " : ""}topic_id, service_id, tags, approval_status)
       VALUES (?, ?, ?, ?, ?, ?, ${scope != null ? "?, " : ""}?, ?, ?, 'draft')`,
      [
        title,
        label,
        question,
        announceBody,
        body.sourcePostId ?? null,
        body.createdBy ?? null,
        ...(scope != null ? [scope] : []),
        topicId,
        serviceId,
        tagsJson,
      ],
    );
    return c.json(
      { ok: true, id: (ins as { insertId: number }).insertId, approvalStatus: "draft" },
      201,
    );
  }),
);

// 본문 수정 — title/label/body/question + 분류(scope/topicId/serviceId/tags). 가드 admin.
app.patch("/announces/:id", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json<{
      title?: string;
      label?: string | null;
      body?: string;
      answer?: string; // SA UI 별칭
      question?: string | null;
      scope?: string | null;
      topicId?: number | null;
      serviceId?: number | null;
      tags?: unknown;
    }>();
    const assetBase = c.env.PMS_ASSET_BASE || DEFAULT_PMS_ASSET_BASE;
    const sets: string[] = [];
    const params: unknown[] = [];
    // body(본문) 변경 시 게이트 재평가(H-1) — 저장될 최종 본문을 보관.
    let newBody: string | null = null;

    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t) return c.json({ error: "title empty" }, 400);
      if (t.length > 150) return c.json({ error: "title too long (<=150)" }, 400);
      sets.push("title = ?");
      params.push(t);
    }
    // label 은 NULL 허용 — 빈 문자열/null 이면 해제.
    if (body.label !== undefined) {
      const l = body.label === null ? "" : String(body.label).trim();
      sets.push("label = ?");
      params.push(l || null);
    }
    // body 우선, answer(SA UI 별칭) 폴백 — 둘 중 보낸 것만 적용. 이미지 절대화.
    if (body.body !== undefined || body.answer !== undefined) {
      const raw = (body.body ?? body.answer ?? "").trim();
      if (!raw) return c.json({ error: "body empty" }, 400);
      const absolutized = absolutizePmsAssets(raw, assetBase);
      newBody = absolutized;
      sets.push("body = ?");
      params.push(absolutized);
    }
    // question 은 NULL 허용 — null/빈문자 이면 해제, 있으면 절대화.
    if (body.question !== undefined) {
      const qraw = body.question === null ? "" : String(body.question).trim();
      sets.push("question = ?");
      params.push(qraw ? absolutizePmsAssets(qraw, assetBase) : null);
    }
    if (body.scope !== undefined && body.scope !== null && body.scope !== "") {
      if (body.scope !== "common" && body.scope !== "service") {
        return c.json({ error: "scope must be common|service" }, 400);
      }
      sets.push("scope = ?");
      params.push(body.scope);
    }
    if (body.topicId !== undefined) {
      if (body.topicId === null) {
        sets.push("topic_id = ?");
        params.push(null);
      } else {
        const tid = Number(body.topicId);
        if (!Number.isInteger(tid)) return c.json({ error: "invalid topicId" }, 400);
        const v = await validateTopic(conn, tid);
        if (!v.ok) return c.json({ error: v.reason }, 400);
        sets.push("topic_id = ?");
        params.push(tid);
      }
    }
    if (body.serviceId !== undefined) {
      if (body.serviceId === null) {
        sets.push("service_id = ?");
        params.push(null);
      } else {
        const sid = Number(body.serviceId);
        if (!Number.isInteger(sid)) return c.json({ error: "invalid serviceId" }, 400);
        const v = await validateService(conn, sid);
        if (!v.ok) return c.json({ error: v.reason }, 400);
        sets.push("service_id = ?");
        params.push(sid);
      }
    }
    if (body.tags !== undefined) {
      const tagsJson = serializeTags(body.tags);
      if (tagsJson === undefined) return c.json({ error: "tags must be an array of strings" }, 400);
      sets.push("tags = ?");
      params.push(tagsJson);
    }
    if (!sets.length) return c.json({ error: "no fields" }, 400);
    params.push(id);
    const [result] = await conn.query(
      `UPDATE hp_announce SET ${sets.join(", ")} WHERE id = ? AND status = 1`,
      params,
    );
    // H-1: body(본문) 변경 시 PII 게이트 재평가 — 텍스트 재스캔·이미지 리셋·승인 강등.
    let gateReevaluated = false;
    if (newBody !== null) {
      await reevaluateGateOnBodyChange(conn, "hp_announce", id, newBody);
      gateReevaluated = true;
    }
    return c.json({
      ok: true,
      affected: (result as { affectedRows?: number }).affectedRows,
      changed: (result as { changedRows?: number }).changedRows,
      gateReevaluated,
    });
  }),
);

// soft-delete (status=-1). 가드 admin.
app.delete("/announces/:id", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    await conn.query(`UPDATE hp_announce SET status = -1 WHERE id = ?`, [id]);
    return c.json({ ok: true });
  }),
);

// 승인 워크플로 상태 전이 (§3-2/§3-3) — SA 전이표(SA_TRANSITIONS)·권한 재사용. 가드 developer↑.
// reviewing→approved 자동 게이트 + 원자적 버전 교체 + archivedReason 수용 — SA 와 동일 정책.
app.patch("/announces/:id/transition", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    type TransBody = { to?: string; reason?: string; archivedReason?: string };
    const reqBody = await c.req.json<TransBody>().catch((): TransBody => ({}));
    const to = reqBody.to;
    if (!to || !(SA_APPROVALS as readonly string[]).includes(to)) {
      return c.json({ error: "to must be one of draft|reviewing|approved|rejected|archived" }, 400);
    }
    const target = to as SaApproval;

    // 007·006 컬럼 존재 여부(graceful degrade).
    const [hasSupersedesColAn, hasSupersededByColAn, hasArchivedReasonColAn, hasLastVerifiedColAn] = await Promise.all([
      hasCol(conn, "hp_announce", "supersedes_id"),
      hasCol(conn, "hp_announce", "superseded_by_id"),
      hasCol(conn, "hp_announce", "archived_reason"),
      hasCol(conn, "hp_announce", "last_verified_at"),
    ]);
    const [hasPiiTextColAn, hasImagePiiColAn] = await Promise.all([
      hasCol(conn, "hp_announce", "pii_text_status"),
      hasCol(conn, "hp_announce", "image_pii_status"),
    ]);

    const selectCols = [
      "id", "approval_status", "scope", "service_id",
      ...(hasSupersedesColAn ? ["supersedes_id"] : []),
    ].join(", ");
    const [rows] = await conn.query(
      `SELECT ${selectCols} FROM hp_announce WHERE id = ? AND status = 1`,
      [id],
    );
    const cur = (rows as {
      approval_status: SaApproval;
      scope: SaScope;
      service_id: number | null;
      supersedes_id?: number | null;
    }[])[0];
    if (!cur) return c.json({ error: "not found" }, 404);
    const from = cur.approval_status;

    if (!SA_TRANSITIONS[from]?.includes(target)) {
      return c.json({ error: `invalid transition: ${from} -> ${target}`, from, allowed: SA_TRANSITIONS[from] ?? [] }, 422);
    }

    const reason = (reqBody.reason ?? "").trim();
    if (target === "rejected" && !reason) {
      return c.json({ error: "rejection_reason required for rejected (§3-4)" }, 400);
    }

    type GateResult = "pass" | "fail" | "skip";
    const gate: { classification: GateResult; pii: GateResult } = { classification: "pass", pii: "skip" };

    if (target === "approved" && from === "reviewing") {
      // (A) 분류 게이트 — 항상 적용.
      if (cur.scope === "service" && cur.service_id == null) {
        gate.classification = "fail";
        return c.json({
          error: "분류 게이트: scope=service 인데 service_id 가 지정되지 않았습니다.",
          code: "ERR_CLASSIFY",
          failed: ["classification"],
          gate,
        }, 422);
      }
      // (B) PII 게이트(006 컬럼 있을 때만).
      if (hasPiiTextColAn || hasImagePiiColAn) {
        if (hasPiiTextColAn) {
          const textGate = await applyTextPiiGate(conn, "hp_announce", id);
          if (textGate.blocked) {
            gate.pii = "fail";
            return c.json({
              error: "PII 게이트: 본문에서 고유식별정보 패턴이 발견되어 승인할 수 없습니다. 마스킹 후 재시도하세요.",
              code: "ERR_PII",
              failed: ["pii"],
              piiTextStatus: "blocked",
              matchedCount: textGate.matchedCount,
              privateSource: textGate.privateSource === 1,
              gate: { ...gate, pii: "fail" },
            }, 422);
          }
        }
        if (hasImagePiiColAn) {
          const imgGate = await checkImageGate(conn, "hp_announce", id);
          if (imgGate.blocked) {
            gate.pii = "fail";
            return c.json({
              error: "PII 게이트: 인용 이미지 검수가 완료되지 않아 승인할 수 없습니다. 이미지 검수(clear/removed/masked) 후 재시도하세요.",
              code: "ERR_PII",
              failed: ["pii"],
              imagePiiStatus: imgGate.imagePiiStatus,
              gate: { ...gate, pii: "fail" },
            }, 422);
          }
        }
        gate.pii = "pass";
      }
    }

    // 원자적 버전 교체(reviewing→approved + supersedes_id 있을 때, 007 컬럼 있을 때).
    const supersedesIdAn: number | null = hasSupersedesColAn ? (cur.supersedes_id ?? null) : null;
    const doVersionSwapAn = target === "approved" && from === "reviewing" && supersedesIdAn != null
      && hasSupersedesColAn && hasSupersededByColAn && hasArchivedReasonColAn;

    const approverAn = c.get("session").email ?? null;

    if (doVersionSwapAn) {
      await (conn as { beginTransaction(): Promise<void> }).beginTransaction();
      try {
        const newSets: string[] = ["approval_status = 'approved'", "approved_by = ?", "approved_at = NOW()"];
        const newParams: unknown[] = [approverAn];
        if (hasLastVerifiedColAn) newSets.push("last_verified_at = NOW()");
        newParams.push(id);
        await conn.query(
          `UPDATE hp_announce SET ${newSets.join(", ")} WHERE id = ? AND status = 1`,
          newParams,
        );
        const oldSets: string[] = [
          "approval_status = 'archived'",
          "archived_reason = 'superseded'",
          "superseded_by_id = ?",
        ];
        const oldParams: unknown[] = [id, supersedesIdAn];
        await conn.query(
          `UPDATE hp_announce SET ${oldSets.join(", ")} WHERE id = ? AND status = 1`,
          oldParams,
        );
        await (conn as { commit(): Promise<void> }).commit();
      } catch (txErr) {
        await (conn as { rollback(): Promise<void> }).rollback();
        throw txErr;
      }
      return c.json({ ok: true, id, from, to: target, gate, supersededId: supersedesIdAn });
    }

    const sets: string[] = ["approval_status = ?"];
    const params: unknown[] = [target];
    if (target === "approved") {
      sets.push("approved_by = ?", "approved_at = NOW()");
      params.push(approverAn);
      if (hasLastVerifiedColAn) sets.push("last_verified_at = NOW()");
    }
    if (target === "rejected") {
      sets.push("rejection_reason = ?", "approved_by = ?");
      params.push(reason, approverAn);
    }
    if (target === "archived") {
      const archivedReasonInput = (reqBody.archivedReason ?? "").trim();
      const VALID_AR = ["superseded", "outdated", "domain_closed"] as const;
      if (hasArchivedReasonColAn && archivedReasonInput && (VALID_AR as readonly string[]).includes(archivedReasonInput)) {
        sets.push("archived_reason = ?");
        params.push(archivedReasonInput);
      }
    }
    params.push(id);
    await conn.query(
      `UPDATE hp_announce SET ${sets.join(", ")} WHERE id = ? AND status = 1`,
      params,
    );
    return c.json({ ok: true, id, from, to: target, ...(target === "approved" ? { gate } : {}) });
  }),
);

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ 이미지 Vision 1차 PII 플래그 (C) — 보조. 자동 'clear' 금지(사람검수 기본).   ║
// ║   POST /standard-answers/:id/pii-image-scan  (announce 는 ?table=announce)  ║
// ║   인용 이미지(<img src>) Vision 스캔: "PII 유형·영역 좌표만 반환, 값 미전사".║
// ║   의심 신호 → image_pii_status='suspect', 아니면 'pending' 유지.            ║
// ║   ⛔ AI Gateway 로그에 PII·이미지 잔존 유의 — 프롬프트가 값 전사 금지.        ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
type PiiImageScanResult = {
  suspect: boolean;
  signals: string[]; // 의심 유형 라벨만 (예: "인명","연락처","명단","계좌","고유식별정보화면"). 값 미포함.
  regions: number; // 의심 영역 개수(좌표 상세는 미저장)
};

/** 본문 HTML 에서 <img src> 목록 추출(절대 URL 우선). */
function extractImgSrcs(html: string): string[] {
  const out: string[] = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(html ?? ""))) !== null) {
    if (m[2]) out.push(m[2]);
  }
  return Array.from(new Set(out));
}

async function scanImagesForPii(
  env: Bindings,
  imageUrls: string[],
): Promise<{
  suspect: boolean;
  signals: string[];
  regions: number;
  scanned: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  errors: number;
  model: string | null;
}> {
  const signalSet = new Set<string>();
  let regions = 0;
  let anySuspect = false;
  let scanned = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd = 0;
  let errors = 0;
  let model: string | null = null;
  // 비용·레이트 보호: 1회 호출당 이미지 상한.
  for (const url of imageUrls.slice(0, 8)) {
    try {
      const r = await callOpenAiJson<PiiImageScanResult>(env, {
        model: env.LLM_MODEL_PREMIUM,
        system: [
          "너는 이미지 PII(개인식별정보) 1차 스크리너다. 화면 캡처에 개인정보가 보이는지 판별만 한다.",
          "⛔ 절대 규칙: PII 값(이름·번호·계좌·주민번호 등)을 절대 전사·인용하지 마라. 값은 출력 금지.",
          "오직 '유형 라벨'과 '의심 영역 개수'만 보고하라.",
          "의심 신호 예: 인명, 연락처(전화/이메일), 명단/리스트, 계좌/카드번호, 주민번호 등 고유식별정보 화면.",
          '출력 JSON: {"suspect": <true|false>, "signals": ["인명","연락처", ...], "regions": <정수>}',
          "signals 에는 라벨만, 실제 값은 절대 넣지 마라. 확실치 않으면 suspect=true(보수적).",
        ].join("\n"),
        user: "이 이미지에 개인식별정보가 보이는지 유형 라벨과 의심 영역 개수만 판별하라. 값은 전사 금지.",
        images: [url],
        maxTokens: 300,
        temperature: 0,
        timeoutMs: 30_000,
      });
      scanned++;
      promptTokens += r.promptTokens ?? 0;
      completionTokens += r.completionTokens ?? 0;
      costUsd += r.costUsd ?? 0;
      model = r.model ?? model;
      const d = r.data;
      if (d?.suspect) anySuspect = true;
      for (const s of Array.isArray(d?.signals) ? d.signals : []) {
        if (typeof s === "string" && s.trim()) signalSet.add(s.trim().slice(0, 30));
      }
      regions += Number.isFinite(d?.regions) ? Math.max(0, Math.trunc(Number(d.regions))) : 0;
    } catch {
      // 스캔 실패 → 보수적으로 의심 처리(자동 clear 금지 원칙).
      anySuspect = true;
      errors++;
      signalSet.add("scan_error");
    }
  }
  return {
    suspect: anySuspect,
    signals: Array.from(signalSet),
    regions,
    scanned,
    promptTokens,
    completionTokens,
    costUsd,
    errors,
    model,
  };
}

app.post("/standard-answers/:id/pii-image-scan", requireAuth, requireRole(ROLE_LEVEL.developer), rateLimitLlm, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const table = c.req.query("table") === "announce" ? "hp_announce" : "hp_standard_answer";
    const bodyCol = table === "hp_announce" ? "body" : "answer";

    const [rows] = await conn.query(
      `SELECT id, ${bodyCol} AS body, image_pii_status FROM ${table} WHERE id = ? AND status = 1`,
      [id],
    );
    const row = (rows as { id: number; body: string | null; image_pii_status: ImagePiiStatus }[])[0];
    if (!row) return c.json({ error: "not found" }, 404);

    // 사람검수로 확정된 상태(clear/removed/masked/blocked)는 재스캔이 덮지 않음(보호).
    if (["clear", "removed", "masked", "blocked"].includes(row.image_pii_status)) {
      return c.json({ ok: true, id, skipped: true, reason: `already ${row.image_pii_status} (사람검수 확정)`, imagePiiStatus: row.image_pii_status });
    }

    const imgs = extractImgSrcs(row.body ?? "");
    if (imgs.length === 0) {
      await conn.query(`UPDATE ${table} SET image_pii_status = 'none' WHERE id = ?`, [id]);
      return c.json({ ok: true, id, imagePiiStatus: "none", images: 0 });
    }

    const result = await scanImagesForPii(c.env, imgs);
    // 자동 'clear' 금지 — 의심이면 'suspect', 아니면 'pending' 유지(사람검수 대기).
    const next: ImagePiiStatus = result.suspect ? "suspect" : "pending";
    await conn.query(`UPDATE ${table} SET image_pii_status = ? WHERE id = ?`, [next, id]);

    return c.json({
      ok: true,
      id,
      imagePiiStatus: next, // 'suspect' | 'pending' (자동 clear 없음)
      images: imgs.length,
      scanned: result.scanned,
      signals: result.signals, // 유형 라벨만(값 미포함)
      regions: result.regions,
    });
  }),
);

// 사람 검수 결과로 이미지 PII 상태 확정(C 후속) — clear/removed/masked/blocked 만 허용.
// 검수자·시각 기록. 가드 admin(최종 게이트 통과 권한).
app.patch("/standard-answers/:id/pii-image-review", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const table = c.req.query("table") === "announce" ? "hp_announce" : "hp_standard_answer";
    type ReviewBody = { status?: string };
    const body = await c.req.json<ReviewBody>().catch((): ReviewBody => ({}));
    const ALLOWED: ImagePiiStatus[] = ["clear", "removed", "masked", "blocked"];
    if (!body.status || !ALLOWED.includes(body.status as ImagePiiStatus)) {
      return c.json({ error: "status must be one of clear|removed|masked|blocked" }, 400);
    }
    const [rows] = await conn.query(`SELECT id FROM ${table} WHERE id = ? AND status = 1`, [id]);
    if ((rows as unknown[]).length === 0) return c.json({ error: "not found" }, 404);
    await conn.query(
      `UPDATE ${table} SET image_pii_status = ?, pii_checked_by = ?, pii_checked_at = NOW() WHERE id = ? AND status = 1`,
      [body.status, c.get("session").email ?? null, id],
    );
    return c.json({ ok: true, id, imagePiiStatus: body.status });
  }),
);

// 이미지 PII Vision 1차 스캔 배치(검수 큐 트리아지) — admin 인증 운영 도구.
// id 커서(afterId)로 멱등 전진. 무탐도 'pending' 유지(자동 clear 금지) → id>afterId 로 재스캔 방지.
// 가드: requireServiceToken(관찰) + requireAuth + requireRole(developer). 무인증 노출 없음.
app.post("/standard-answers/pii-image-scan-batch", requireServiceToken, requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const table = c.req.query("table") === "announce" ? "hp_announce" : "hp_standard_answer";
    const bodyCol = table === "hp_announce" ? "body" : "answer";
    const limit = Math.min(40, Math.max(1, parseInt(c.req.query("limit") ?? "30", 10)));
    const afterId = Math.max(0, parseInt(c.req.query("afterId") ?? "0", 10));
    const [rows] = await conn.query(
      `SELECT id, ${bodyCol} AS body FROM ${table}
        WHERE status = 1 AND image_pii_status = 'pending' AND ${bodyCol} LIKE '%<img%' AND id > ?
        ORDER BY id ASC LIMIT ?`,
      [afterId, limit],
    );
    const list = rows as { id: number; body: string | null }[];
    let suspect = 0, pendingKept = 0, none = 0, scanned = 0, errors = 0;
    let costUsd = 0, promptTokens = 0, completionTokens = 0, lastId = afterId;
    for (const row of list) {
      lastId = row.id;
      const imgs = extractImgSrcs(row.body ?? "");
      if (imgs.length === 0) {
        await conn.query(`UPDATE ${table} SET image_pii_status = 'none' WHERE id = ? AND status = 1`, [row.id]);
        none++;
        continue;
      }
      const r = await scanImagesForPii(c.env, imgs);
      const next: ImagePiiStatus = r.suspect ? "suspect" : "pending";
      await conn.query(`UPDATE ${table} SET image_pii_status = ? WHERE id = ? AND status = 1`, [next, row.id]);
      if (next === "suspect") suspect++; else pendingKept++;
      scanned += r.scanned;
      errors += r.errors;
      costUsd += r.costUsd;
      promptTokens += r.promptTokens;
      completionTokens += r.completionTokens;
    }
    return c.json({
      ok: true,
      table,
      processed: list.length,
      lastId,
      done: list.length < limit,
      suspect,
      pendingKept,
      none,
      scanned,
      errors,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      promptTokens,
      completionTokens,
    });
  }),
);


// 게시글(문의) 1건 + 작성자 + (공개) 댓글 흐름.
// 직원/고객 구분은 email 도메인(@malgnsoft.com) 기준. private_yn='Y' 댓글 본문은 마스킹.
app.get("/pms/posts/:id", requireAuth, async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    const [postRows] = await conn.query(
      `SELECT p.id, p.subject, p.content, p.project_id, p.site_id,
              p.writer, p.reg_date, p.comm_cnt,
              u.email AS writer_email, u.company AS writer_company,
              (u.email LIKE '%@malgnsoft.com' OR u.company = '맑은소프트') AS writer_is_staff
         FROM tb_post p
    LEFT JOIN tb_user u ON u.id = p.user_id
        WHERE p.id = ? AND p.status = 1`,
      [id],
    );
    const post = (postRows as any[])[0];
    if (!post) return c.json({ error: "not found" }, 404);

    const [commentRows] = await conn.query(
      `SELECT c.id, c.content, c.writer, c.reg_date, c.private_yn,
              u.email AS writer_email,
              (u.email LIKE '%@malgnsoft.com' OR u.company = '맑은소프트') AS writer_is_staff
         FROM tb_post_comment c
    LEFT JOIN tb_user u ON u.id = c.user_id
        WHERE c.post_id = ? AND c.status = 1
        ORDER BY c.reg_date ASC`,
      [id],
    );

    const comments = (commentRows as any[]).map((r) => {
      const isPrivate = r.private_yn === "Y";
      return {
        id: r.id,
        writer: r.writer,
        writerIsStaff: r.writer_is_staff === 1,
        regDate: toIso(r.reg_date),
        isPrivate,
        // 비공개 댓글 본문은 챗봇·외부 노출 금지 — 메타만 반환
        content: isPrivate ? null : r.content,
      };
    });

    return c.json({
      post: {
        id: post.id,
        subject: post.subject,
        content: post.content,
        projectId: post.project_id,
        siteId: post.site_id,
        writer: post.writer,
        writerCompany: post.writer_company,
        writerIsStaff: post.writer_is_staff === 1,
        regDate: toIso(post.reg_date),
        commentCount: post.comm_cnt ?? comments.length,
      },
      comments,
      meta: {
        privateCommentsHidden: comments.filter((x) => x.isPrivate).length,
      },
    });
  }),
);

// ── PMS 문의 수집 — 스캔/미리보기 파이프라인 ──────────────
// 정본: malgn-helper-mng/docs/PMS-INQUIRY-HARVEST.md §5(단계별 절차) · TOPIC-CATALOG.md(24토픽)
//
// POST /pms/harvest/scan (developer↑) — 기간·그룹 스캔으로 수집 후보를 미리보기 생성.
//   파이프라인: ①스캔(제외 룰) → ②서비스 자동 배정 → ③안내글/Q&A 분기 → ④토픽 LLM 배치 분류 → ⑤후보 반환.
//
// ⚠ dryRun=true 가 기본 — hp_* 에 절대 쓰지 않는다(미리보기만). 실제 draft 등록은 이번 범위 밖.
//   읽기 전용(tb_* SELECT). 본문 PII 는 응답에 덤프하지 않는다(제목·메타·분류만; 본문은 LLM 입력으로만 잠깐 사용).

// HARVEST §5-2 — 사내 게시판 그룹명 화이트리스트(숫자 prefix 없는 사내 게시판). 운영자 편집 가능 데이터 후보.
const HARVEST_INTERNAL_GROUP_NAMES = new Set<string>([
  "보고/결재",
  "이러닝컨설팅팀",
  "종료/마감/보관",
  "이러닝개발팀",
  "학습조직",
  "이러닝사업팀",
  "몽골개발팀",
]);

// HARVEST §5-2 — 본문 최소 길이(Q&A 가치 판단 전 1차 부실 필터).
const HARVEST_MIN_CONTENT_LEN = 20;

type HarvestScanBody = {
  from?: string;
  to?: string;
  groupId?: number;
  limit?: number;
  offset?: number;
  dryRun?: boolean;
};

type HarvestTopicSlug = { slug: string; label: string; description: string };

type HarvestCandidate = {
  postId: number;
  title: string;
  groupName: string | null;
  serviceSlug: string | null; // 미매핑(보류)이면 null
  serviceId: number | null;   // hp_service 에서 slug→id 해석(재시드 전이면 null 가능)
  harvestStatus: "ok" | "hold_service"; // §3-3 미매핑 보류 표시
  type: "announce" | "qa";
  topicSlug: string | null;       // 저신뢰·미분류 보류면 null
  topicConfidence: number | null; // 0~1
  hasAnswer: boolean;             // staff 답변(tb_post_comment) 존재 여부
};

// reg_date(varchar14 'YYYYMMDDHHMMSS') 비교용으로 'YYYY-MM-DD' → 'YYYYMMDD000000' / 'YYYYMMDD235959'.
function harvestDateTo14(d: string, end: boolean): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d ?? "").trim());
  if (!m) return null;
  return end ? `${m[1]}${m[2]}${m[3]}235959` : `${m[1]}${m[2]}${m[3]}000000`;
}

app.post(
  "/pms/harvest/scan",
  requireAuth,
  requireRole(ROLE_LEVEL.developer),
  rateLimitLlm,
  async (c) =>
    withConn(c, async (conn) => {
      const t0 = Date.now();
      const route = "POST /pms/harvest/scan";
      const b = await c.req.json<HarvestScanBody>().catch((): HarvestScanBody => ({}));

      const from14 = harvestDateTo14(b.from ?? "2022-01-01", false) ?? "20220101000000";
      const to14 = harvestDateTo14(b.to ?? "2026-12-31", true) ?? "20261231235959";
      const limit = Math.min(Math.max(Number(b.limit ?? 50) || 50, 1), 200);
      const offset = Math.max(Number(b.offset ?? 0) || 0, 0);
      const groupId =
        b.groupId !== undefined && Number.isFinite(Number(b.groupId)) ? Number(b.groupId) : null;
      // dryRun 기본 true. 명시적으로 false 를 줘도 이번 범위에선 쓰지 않으므로 미리보기로 강제하되, 응답에 표기.
      const dryRunRequested = b.dryRun !== false;

      // ── ① 스캔 (제외 룰 적용) ────────────────────────────
      // 제외: 본문 20자 미만 / 사내 업무 게시판(프로젝트명 숫자 prefix) / 사내 그룹 화이트리스트.
      //   site_id=1(메인) 한정. tb_post.status=1.
      const where: string[] = [
        "p.status = 1",
        "p.site_id = 1",
        "p.reg_date BETWEEN ? AND ?",
        "CHAR_LENGTH(p.content) >= ?",
        // 사내 업무 게시판: 프로젝트명 숫자 prefix(예: '01. ', '09. ') 제외
        "proj.name NOT REGEXP '^[0-9]+\\\\.'",
      ];
      const params: unknown[] = [from14, to14, HARVEST_MIN_CONTENT_LEN];

      // 사내 그룹 화이트리스트 제외 (그룹명 기준)
      const internalNames = [...HARVEST_INTERNAL_GROUP_NAMES];
      if (internalNames.length > 0) {
        where.push(`(g.name IS NULL OR g.name NOT IN (${internalNames.map(() => "?").join(",")}))`);
        params.push(...internalNames);
      }
      if (groupId !== null) {
        where.push("proj.group_id = ?");
        params.push(groupId);
      }
      const whereSql = `WHERE ${where.join(" AND ")}`;

      const [countRows] = await conn.query(
        `SELECT COUNT(*) AS total
           FROM tb_post p
           JOIN tb_project proj ON proj.id = p.project_id
      LEFT JOIN tb_project_group g ON g.id = proj.group_id AND g.status = 1
          ${whereSql}`,
        params,
      );
      const scanned = Number((countRows as { total: number }[])[0]?.total ?? 0);

      // 후보 페이지 — staff 판정·그룹명·답변(staff 댓글) 유무 조인.
      const [rows] = await conn.query(
        `SELECT p.id, p.subject, p.content, p.project_id, p.reg_date,
                g.name AS group_name,
                (u.email LIKE '%@malgnsoft.com' OR u.company = '맑은소프트') AS author_is_staff,
                EXISTS (
                  SELECT 1 FROM tb_post_comment cc
                   JOIN tb_user cu ON cu.id = cc.user_id
                   WHERE cc.post_id = p.id AND cc.status = 1
                     AND (cu.email LIKE '%@malgnsoft.com' OR cu.company = '맑은소프트')
                ) AS has_staff_answer
           FROM tb_post p
           JOIN tb_project proj ON proj.id = p.project_id
      LEFT JOIN tb_project_group g ON g.id = proj.group_id AND g.status = 1
      LEFT JOIN tb_user u ON u.id = p.user_id
          ${whereSql}
       ORDER BY p.reg_date DESC, p.id DESC
          LIMIT ${limit} OFFSET ${offset}`,
        params,
      );

      type ScanRow = {
        id: number;
        subject: string | null;
        content: string | null;
        project_id: number;
        reg_date: string;
        group_name: string | null;
        author_is_staff: number;
        has_staff_answer: number;
      };
      const scanRows = rows as ScanRow[];

      // ── ②·③ 서비스 자동 배정 + 안내글/Q&A 분기 (결정적) ──
      // service slug → id 해석(라이브 hp_service). 재시드 전이면 slug 매칭 안 돼 null.
      const [svcRows] = await conn.query(
        `SELECT id, slug FROM hp_service WHERE status = 1 AND active = 1`,
      );
      const slugToServiceId = new Map<string, number>();
      for (const r of svcRows as { id: number; slug: string }[]) {
        slugToServiceId.set(r.slug, Number(r.id));
      }

      const candidates: HarvestCandidate[] = scanRows.map((r) => {
        const serviceSlug = groupNameToServiceSlug(r.group_name);
        // PMS 모델: tb_post 가 스레드 루트(문의/안내), 댓글이 답변 → 각 post 는 첫 글(isFirstPost=true).
        const isAnnounce = isAnnounceCandidate(null, Number(r.author_is_staff) === 1, true);
        return {
          postId: Number(r.id),
          title: r.subject ?? "",
          groupName: r.group_name ?? null,
          serviceSlug,
          serviceId: serviceSlug ? (slugToServiceId.get(serviceSlug) ?? null) : null,
          harvestStatus: serviceSlug ? "ok" : "hold_service",
          type: isAnnounce ? "announce" : "qa",
          topicSlug: null,
          topicConfidence: null,
          hasAnswer: Number(r.has_staff_answer) === 1,
        };
      });

      // ── ④ 토픽 LLM 분류 (배치 1회 호출) ──────────────────
      // 라이브 hp_topic 카탈로그(active) 입력. 제목 + 짧은 본문 발췌(120자)만 LLM 입력(PII 최소화).
      let llmCostUsd = 0;
      let llmPromptTokens = 0;
      let llmCompletionTokens = 0;
      let llmModel: string | null = null;
      let llmLatencyMs: number | null = null;
      let llmError: string | null = null;
      const confidenceThreshold = 0.6; // HARVEST §5-5 기본 임계(저신뢰 보류)

      if (candidates.length > 0 && c.env.OPENAI_API_KEY) {
        const [topicRows] = await conn.query(
          `SELECT slug, label, description FROM hp_topic
            WHERE status = 1 AND active = 1
            ORDER BY scope, sort_order, id`,
        );
        const catalog = (topicRows as HarvestTopicSlug[]).map((t) => ({
          slug: t.slug,
          label: t.label,
          description: t.description ?? "",
        }));
        const validSlugs = new Set(catalog.map((t) => t.slug));

        // LLM 입력 아이템: 본문은 발췌(120자)만. 응답엔 본문 미포함.
        const items = candidates.map((cand, i) => {
          const src = scanRows[i];
          const excerpt = String(src.content ?? "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
          return { i, title: cand.title.slice(0, 120), excerpt };
        });

        try {
          const llm = await callOpenAiJson<{
            results: Array<{ i: number; topic_slug: string | null; confidence: number }>;
          }>(c.env, {
            model: c.env.LLM_MODEL_DEFAULT,
            system: [
              "너는 고객상담 문의를 사전 정의된 토픽 카탈로그 중 하나로 분류하는 분류기다.",
              "각 항목(title + excerpt)을 읽고 가장 적합한 topic_slug 1개와 confidence(0~1)를 매겨라.",
              "규칙:",
              "- topic_slug 는 반드시 아래 카탈로그의 slug 중 하나이거나, 적합한 것이 없으면 null.",
              "- 이름·회사로 도메인 추정 금지. 본문(title/excerpt) 내용만 근거.",
              "- 애매하면 confidence 를 낮게(<0.6) 주고, 정말 해당 없으면 topic_slug=null.",
              "출력 JSON: {\"results\":[{\"i\":번호,\"topic_slug\":\"slug 또는 null\",\"confidence\":0~1}]}",
              "모든 입력 항목 i 에 대해 정확히 1개 결과를 반환하라.",
              "",
              "=== 토픽 카탈로그 ===",
              ...catalog.map((t) => `- ${t.slug} (${t.label}): ${t.description}`),
            ].join("\n"),
            user: JSON.stringify({ items }),
            maxTokens: Math.min(200 + items.length * 30, 4000),
            temperature: 0,
          });
          llmModel = llm.model;
          llmPromptTokens = llm.promptTokens;
          llmCompletionTokens = llm.completionTokens;
          llmLatencyMs = llm.latencyMs;
          llmCostUsd = llm.costUsd;

          for (const res of llm.data.results ?? []) {
            const idx = Number(res.i);
            if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) continue;
            const slug = res.topic_slug;
            const conf = typeof res.confidence === "number" ? res.confidence : 0;
            if (slug && validSlugs.has(slug) && conf >= confidenceThreshold) {
              candidates[idx].topicSlug = slug;
              candidates[idx].topicConfidence = conf;
            } else {
              // 저신뢰·미분류·카탈로그 외 → 보류(null) + 신뢰도만 참고로 기록
              candidates[idx].topicSlug = null;
              candidates[idx].topicConfidence = slug ? conf : null;
            }
          }
        } catch (e) {
          llmError = e instanceof Error ? e.message : String(e);
        }
      }

      // ── 감사 로그 (hp_llm_log) — 미리보기여도 LLM 호출 비용/실패는 기록 ──
      try {
        await conn.query(
          `INSERT INTO hp_llm_log
             (route, entity_type, entity_id, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, cache_hit, error)
           VALUES (?, 'harvest_scan', 0, ?, ?, ?, ?, ?, 0, ?)`,
          [
            route,
            llmModel ?? "none",
            llmPromptTokens,
            llmCompletionTokens,
            llmCostUsd,
            llmLatencyMs ?? (Date.now() - t0),
            llmError,
          ],
        );
      } catch {
        // 로그 실패는 응답을 막지 않는다.
      }

      // ── ⑤ 후보 반환 (본문 PII 미포함) ────────────────────
      return c.json({
        dryRun: true, // 이번 범위는 항상 미리보기 — hp_* 미기록
        dryRunRequested,
        scanned,
        from: from14,
        to: to14,
        limit,
        offset,
        returned: candidates.length,
        confidenceThreshold,
        candidates,
        llm: {
          model: llmModel,
          promptTokens: llmPromptTokens,
          completionTokens: llmCompletionTokens,
          costUsd: llmCostUsd,
          latencyMs: llmLatencyMs,
          error: llmError,
        },
        llmCostUsd,
      });
    }),
);

// POST /pms/harvest/commit (developer↑) — scan 후보 중 사람이 선택·분류 보정한 것만 draft 등록.
//   HARVEST §5-6·§5-7 — ⑤가치판단(채택) → ⑥draft 등록(분류·유형 태깅 확정).
//   읽기 tb_*(SELECT만, PMS 원본 불변) · 쓰기 hp_* 만(항상 approval_status='draft').
//   item별 독립 처리(한 건 실패가 전체 롤백 아님). 응답엔 본문 PII 미포함(postId·id·reason만).
type HarvestCommitItem = {
  postId?: number;
  type?: "qa" | "announce";
  serviceId?: number | null;
  topicId?: number | null;
  scope?: "common" | "service";
};
type HarvestCommitBody = { items?: HarvestCommitItem[] };

type HarvestCommitted = {
  postId: number;
  table: "standard_answer" | "announce";
  id: number;
};
type HarvestSkipped = {
  postId: number;
  reason: "already" | "no_answer" | "bad_classification" | "not_found" | "bad_item";
};

// 안전 상한 — 자동 대량 등록 금지(사람이 선택·보정한 명시분만).
const HARVEST_COMMIT_MAX_ITEMS = 200;
// 제목 라벨 절단 길이(80자 이내 요약/절단). hp_standard_answer.label 컬럼은 <=100.
const HARVEST_LABEL_MAX = 80;

function harvestLabel(title: string): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= HARVEST_LABEL_MAX) return t;
  return `${t.slice(0, HARVEST_LABEL_MAX - 1)}…`;
}

app.post(
  "/pms/harvest/commit",
  requireAuth,
  requireRole(ROLE_LEVEL.developer),
  async (c) =>
    withConn(c, async (conn) => {
      const session = c.get("session");
      const createdBy = session?.email ?? null;
      const assetBase = c.env.PMS_ASSET_BASE || DEFAULT_PMS_ASSET_BASE;

      const b = await c.req.json<HarvestCommitBody>().catch((): HarvestCommitBody => ({}));
      const items = Array.isArray(b.items) ? b.items : null;
      if (!items || items.length === 0) {
        return c.json({ error: "items required (non-empty array)" }, 400);
      }
      if (items.length > HARVEST_COMMIT_MAX_ITEMS) {
        return c.json(
          { error: `too many items (max ${HARVEST_COMMIT_MAX_ITEMS})` },
          400,
        );
      }

      const committed: HarvestCommitted[] = [];
      const skipped: HarvestSkipped[] = [];

      for (const item of items) {
        const postId = Number(item?.postId);
        // 잘못된 item 하나가 전체를 막지 않게 — postId 불량은 0으로 표기하고 skip.
        if (!Number.isInteger(postId) || postId <= 0) {
          skipped.push({ postId: Number.isFinite(postId) ? postId : 0, reason: "bad_item" });
          continue;
        }
        const type = item?.type;
        if (type !== "qa" && type !== "announce") {
          skipped.push({ postId, reason: "bad_item" });
          continue;
        }

        try {
          // 1) 중복 차단 — 이미 등록(status=1)된 source_post_id 면 skip.
          const [dupSa] = await conn.query(
            `SELECT 1 FROM hp_standard_answer WHERE source_post_id = ? AND status = 1 LIMIT 1`,
            [postId],
          );
          const [dupAn] = await conn.query(
            `SELECT 1 FROM hp_announce WHERE source_post_id = ? AND status = 1 LIMIT 1`,
            [postId],
          );
          if ((dupSa as unknown[]).length > 0 || (dupAn as unknown[]).length > 0) {
            skipped.push({ postId, reason: "already" });
            continue;
          }

          // 2) tb_post 조회(원본 불변, SELECT만). site_id=1·status=1.
          const [postRows] = await conn.query(
            `SELECT p.id, p.subject, p.content, p.project_id
               FROM tb_post p
              WHERE p.id = ? AND p.status = 1 AND p.site_id = 1`,
            [postId],
          );
          const post = (postRows as {
            id: number;
            subject: string | null;
            content: string | null;
            project_id: number;
          }[])[0];
          if (!post) {
            skipped.push({ postId, reason: "not_found" });
            continue;
          }

          // 분류 검증 — scope.
          let scope: SaScope | null = null;
          if (item.scope != null) {
            if (item.scope !== "common" && item.scope !== "service") {
              skipped.push({ postId, reason: "bad_classification" });
              continue;
            }
            scope = item.scope;
          }
          // topic_id / service_id 존재·active 검증(미지정 null 허용). 불량이면 그 item만 skip.
          let topicId: number | null = null;
          if (item.topicId != null) {
            const tid = Number(item.topicId);
            if (!Number.isInteger(tid)) {
              skipped.push({ postId, reason: "bad_classification" });
              continue;
            }
            const v = await validateTopic(conn, tid);
            if (!v.ok) {
              skipped.push({ postId, reason: "bad_classification" });
              continue;
            }
            topicId = tid;
          }
          let serviceId: number | null = null;
          if (item.serviceId != null) {
            const sid = Number(item.serviceId);
            if (!Number.isInteger(sid)) {
              skipped.push({ postId, reason: "bad_classification" });
              continue;
            }
            const v = await validateService(conn, sid);
            if (!v.ok) {
              skipped.push({ postId, reason: "bad_classification" });
              continue;
            }
            serviceId = sid;
          }

          const title = String(post.subject ?? "").trim();

          if (type === "qa") {
            // 3) staff 첫 답변(tb_post_comment) 조회 — 비공개 제외, 가장 이른 staff 댓글.
            const [ansRows] = await conn.query(
              `SELECT c.content
                 FROM tb_post_comment c
                 JOIN tb_user cu ON cu.id = c.user_id
                WHERE c.post_id = ? AND c.status = 1
                  AND c.private_yn != 'Y'
                  AND (cu.email LIKE '%@malgnsoft.com' OR cu.company = '맑은소프트')
                  AND c.content IS NOT NULL AND c.content != ''
             ORDER BY c.reg_date ASC, c.id ASC
                LIMIT 1`,
              [postId],
            );
            const rawAnswer = String((ansRows as { content: string | null }[])[0]?.content ?? "").trim();
            if (!rawAnswer) {
              // 답변 없으면 표준답변 불가(§5-6 (a)).
              skipped.push({ postId, reason: "no_answer" });
              continue;
            }

            const label = harvestLabel(title) || `문의 #${postId}`;
            const question = absolutizePmsAssets(String(post.content ?? "").trim(), assetBase);
            const answer = absolutizePmsAssets(rawAnswer, assetBase);

            const [ins] = await conn.query(
              `INSERT INTO hp_standard_answer
                 (label, question, answer, project_id, source_post_id, created_by,
                  ${scope != null ? "scope, " : ""}topic_id, service_id, approval_status)
               VALUES (?, ?, ?, ?, ?, ?, ${scope != null ? "?, " : ""}?, ?, 'draft')`,
              [
                label,
                question,
                answer,
                post.project_id ?? null,
                postId,
                createdBy,
                ...(scope != null ? [scope] : []),
                topicId,
                serviceId,
              ],
            );
            committed.push({
              postId,
              table: "standard_answer",
              id: (ins as { insertId: number }).insertId,
            });
          } else {
            // type === "announce" — 본문 자체가 안내 콘텐츠(질문-답변 쌍 아님). question=NULL.
            const bodyText = absolutizePmsAssets(String(post.content ?? "").trim(), assetBase);
            // hp_announce.title 컬럼 <=150 — 초과분 절단.
            const announceTitle = (title || `안내 #${postId}`).slice(0, 150);

            const [ins] = await conn.query(
              `INSERT INTO hp_announce
                 (title, question, body, source_post_id, created_by,
                  ${scope != null ? "scope, " : ""}topic_id, service_id, approval_status)
               VALUES (?, NULL, ?, ?, ?, ${scope != null ? "?, " : ""}?, ?, 'draft')`,
              [
                announceTitle,
                bodyText,
                postId,
                createdBy,
                ...(scope != null ? [scope] : []),
                topicId,
                serviceId,
              ],
            );
            committed.push({
              postId,
              table: "announce",
              id: (ins as { insertId: number }).insertId,
            });
          }
        } catch {
          // 한 건의 실패가 전체를 롤백하지 않는다 — bad_item 으로 표기하고 계속.
          skipped.push({ postId, reason: "bad_item" });
        }
      }

      return c.json({ committed, skipped });
    }),
);

app.put("/wbs", requireAuth, async (c) => {
  const text = await c.req.text();
  try {
    JSON.parse(text);
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (text.length > 1_000_000) {
    return c.json({ error: "payload too large" }, 413);
  }
  await c.env.R2.put(WBS_KEY, text, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return c.json({ ok: true, size: text.length, savedAt: new Date().toISOString() });
});

// ── 이미지 자산 목록 (hp_image_asset) ──────────────────
// 가드: admin UI(images.vue)만 소비, PMS 미사용. 캡션(개인정보 가능) 노출 방지 → developer 이상.
app.get("/image-assets", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "30", 10) || 30, 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const search = (c.req.query("search") ?? "").trim();
    const source = c.req.query("source") ?? "";
    const projectId = c.req.query("projectId") ?? "";

    const where: string[] = ["status = 1"];
    const params: any[] = [];
    if (search) {
      where.push("(title LIKE ? OR description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like);
    }
    if (source === "inquiry" || source === "reply") {
      where.push("source = ?");
      params.push(source);
    }
    if (projectId) {
      where.push("first_seen_project_id = ?");
      params.push(parseInt(projectId, 10));
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [countRows] = await conn.query(`SELECT COUNT(*) AS total FROM hp_image_asset ${whereSql}`, params);
    const total = Number((countRows as any[])[0]?.total ?? 0);

    const [rows] = await conn.query(
      `SELECT id, src_path, title, description, source,
              first_seen_post_id, first_seen_project_id,
              usage_count, last_used_at, analyzed_at, llm_model
         FROM hp_image_asset ${whereSql}
     ORDER BY analyzed_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    return c.json({
      total,
      limit,
      offset,
      rows: (rows as any[]).map((r) => ({
        id: r.id,
        srcPath: r.src_path,
        absoluteUrl: r.src_path.startsWith("http")
          ? r.src_path
          : `https://ppm.malgn.co.kr/${r.src_path.replace(/^(\.\.\/|\.\/)+/, "").replace(/^\/+/, "")}`,
        title: r.title,
        description: r.description,
        source: r.source,
        firstSeenPostId: r.first_seen_post_id,
        firstSeenProjectId: r.first_seen_project_id,
        usageCount: r.usage_count,
        lastUsedAt: r.last_used_at,
        analyzedAt: r.analyzed_at,
        llmModel: r.llm_model,
      })),
    });
  }),
);

app.get("/image-assets/:id", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const [rows] = await conn.query(`SELECT * FROM hp_image_asset WHERE id = ? AND status = 1`, [id]);
    const row = (rows as any[])[0];
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({
      ...row,
      absoluteUrl: row.src_path.startsWith("http")
        ? row.src_path
        : `https://ppm.malgn.co.kr/${row.src_path.replace(/^(\.\.\/|\.\/)+/, "").replace(/^\/+/, "")}`,
    });
  }),
);

// ── admin 홈 KPI 집계 ─────────────────────────────────
// 가드: 운영 집계(비용·평가·자산 카운트) → developer 이상. admin 홈(index.vue)만 소비.
app.get("/admin/kpi", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    // 표준답변·이미지·평가는 단순 COUNT, 비용은 이번 달
    const [[sa]] = await conn.query<any>(
      `SELECT COUNT(*) AS total FROM hp_standard_answer WHERE status = 1`,
    );
    const [[img]] = await conn.query<any>(
      `SELECT COUNT(*) AS total FROM hp_image_asset WHERE status = 1`,
    );
    const [[evals]] = await conn.query<any>(
      `SELECT COUNT(*) AS total,
              AVG(overall_score) AS avg_score
         FROM hp_qa_eval
        WHERE status = 1 AND overall_score IS NOT NULL`,
    );
    const [[cost]] = await conn.query<any>(
      `SELECT SUM(IFNULL(cost_usd, 0)) AS month_cost,
              COUNT(*) AS month_calls
         FROM hp_llm_log
        WHERE request_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
    );
    const [[brief]] = await conn.query<any>(
      `SELECT COUNT(*) AS total FROM hp_briefing WHERE status = 1`,
    );

    // 최근 활동 (최근 10건 — 평가·이미지·표준답변 등록 시각 기반 합치기)
    const [recent] = await conn.query<any>(
      `(
         SELECT 'qa_eval' AS kind, id, created_at, overall_verdict AS title, post_id AS ref_id
           FROM hp_qa_eval WHERE status = 1 ORDER BY created_at DESC LIMIT 5
       ) UNION ALL (
         SELECT 'image' AS kind, id, created_at, title, first_seen_post_id AS ref_id
           FROM hp_image_asset WHERE status = 1 ORDER BY created_at DESC LIMIT 5
       ) UNION ALL (
         SELECT 'standard_answer' AS kind, id, created_at, label AS title, source_post_id AS ref_id
           FROM hp_standard_answer WHERE status = 1 ORDER BY created_at DESC LIMIT 5
       )
       ORDER BY created_at DESC LIMIT 10`,
    );

    return c.json({
      kpi: {
        standardAnswers: Number(sa.total ?? 0),
        images: Number(img.total ?? 0),
        evals: Number(evals.total ?? 0),
        evalsAvgScore: evals.avg_score != null ? Math.round(Number(evals.avg_score) * 10) / 10 : null,
        briefings: Number(brief.total ?? 0),
        monthCostUsd: Number(cost.month_cost ?? 0),
        monthCalls: Number(cost.month_calls ?? 0),
      },
      recent: (recent as any[]).map((r) => ({
        kind: r.kind,
        id: r.id,
        title: r.title,
        refId: r.ref_id,
        createdAt: r.created_at,
      })),
    });
  }),
);

// ── 인증 (admin · tb_user 기반) ─────────────────────────
// CLAUDE.md/메모리 룰: 직원 = `@malgnsoft.com` 이메일 OR `tb_user.company='맑은소프트'`
// PMS의 tb_user.passwd가 SHA-256 hex 64자라 가정 (사용자 명시).
// 세션 상수·가드(SESSION_COOKIE / requireAuth / requireRole / ROLE_LEVEL)는
// 파일 상단(CORS 직후)으로 이전 — TDZ 회피 위해 라우트 등록보다 앞서야 함.


/** POST /auth/login — login_id + password로 JWT 발급 + httpOnly cookie */
app.post("/auth/login", async (c) =>
  withConn(c, async (conn) => {
    const body = await c.req.json<{ loginId?: string; password?: string }>().catch(() => ({}));
    const loginId = (body.loginId ?? "").trim();
    const password = body.password ?? "";
    if (!loginId || !password) return c.json({ error: "아이디와 비밀번호를 입력하세요." }, 400);

    const passHash = await sha256Hex(password);
    const [rows] = await conn.query(
      `SELECT id, login_id, name, email, company, level, status
         FROM tb_user
        WHERE login_id = ? AND passwd = ? AND status = 1
        LIMIT 1`,
      [loginId, passHash],
    );
    const user = (rows as any[])[0];
    if (!user) return c.json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." }, 401);

    // 직원 검증 (메모리 룰)
    const isStaff =
      (typeof user.email === "string" && user.email.endsWith("@malgnsoft.com")) ||
      user.company === "맑은소프트";
    if (!isStaff) return c.json({ error: "맑은소프트 직원 계정만 로그인할 수 있습니다." }, 403);

    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      sub: user.id,
      loginId: user.login_id,
      name: user.name ?? "",
      email: user.email ?? "",
      company: user.company ?? "",
      level: user.level ?? 0,
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
    };
    const token = await jwtSign(payload, c.env.JWT_SECRET);

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "None", // admin·api가 다른 origin (cross-site)
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });

    return c.json({
      ok: true,
      token,
      user: {
        id: user.id,
        loginId: user.login_id,
        name: user.name,
        email: user.email,
        company: user.company,
        level: user.level,
      },
    });
  }),
);


/**
 * GET /auth/sso — 맑은오피스 SSO 핸드오프.
 * 맑은오피스가 `/slogin?ek=<해시>&id=<email>` 으로 브라우저를 보내고, admin /slogin 이 이 엔드포인트를 호출.
 * ek = SHA-256( `${email}_${yyyyMMdd(KST)}_MALGNHELPER` ) — 단방향 해시(맑은오피스 m.encrypt(...,"SHA-256")와 동일).
 * 검증 성공 시 tb_user(email) 직원 계정으로 세션 쿠키(로그인과 동일) 발급.
 */
app.get("/auth/sso", async (c) =>
  withConn(c, async (conn) => {
    const ek = (c.req.query("ek") ?? "").trim().toLowerCase();
    const id = (c.req.query("id") ?? "").trim(); // email
    if (!ek || !id) return c.json({ error: "ek, id 파라미터가 필요합니다." }, 400);

    // 맑은오피스(KST)의 yyyyMMdd 기준. 자정 경계·시차 허용 위해 오늘/어제 모두 대조.
    const kstYmd = (offsetDays: number) => {
      const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
      return d.toISOString().slice(0, 10).replace(/-/g, "");
    };
    const expected = await Promise.all(
      [0, -1].map((o) => sha256Hex(`${id}_${kstYmd(o)}_MALGNHELPER`)),
    );
    if (!expected.some((h) => h.toLowerCase() === ek)) {
      return c.json({ error: "유효하지 않은 SSO 토큰입니다." }, 401);
    }

    const [rows] = await conn.query(
      `SELECT id, login_id, name, email, company, level, status
         FROM tb_user
        WHERE email = ? AND status = 1
        ORDER BY id
        LIMIT 1`,
      [id],
    );
    const user = (rows as any[])[0];
    if (!user) return c.json({ error: "등록된 사용자가 아닙니다." }, 403);

    // 직원 검증 (로그인과 동일 — admin 은 직원 전용)
    const isStaff =
      (typeof user.email === "string" && user.email.endsWith("@malgnsoft.com")) ||
      user.company === "맑은소프트";
    if (!isStaff) return c.json({ error: "맑은소프트 직원 계정만 로그인할 수 있습니다." }, 403);

    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      sub: user.id,
      loginId: user.login_id,
      name: user.name ?? "",
      email: user.email ?? "",
      company: user.company ?? "",
      level: user.level ?? 0,
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
    };
    const token = await jwtSign(payload, c.env.JWT_SECRET);

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });

    return c.json({
      ok: true,
      token,
      user: {
        id: user.id,
        loginId: user.login_id,
        name: user.name,
        email: user.email,
        company: user.company,
        level: user.level,
      },
    });
  }),
);

/**
 * GET /auth/pms-sso — 맑은도우미 PMS 임베드 SSO 핸드오프.
 * PMS 게시판이 iframe URL에 ?ek=<해시>&email=<email>&pid=<projectId> 를 부착한다.
 * ek = SHA-256( `${email}_${pid}_${yyyyMMdd(KST)}_MALGNHELPER_PMS` ) — PMS m.encrypt(...,"SHA-256")와 동일.
 * 검증 성공 시 tb_user(email) 직원 계정으로 앱 JWT 발급(응답 바디 token). 쿠키는 쓰지 않음(iframe은 Bearer 사용).
 */
app.get("/auth/pms-sso", async (c) =>
  withConn(c, async (conn) => {
    const ek = (c.req.query("ek") ?? "").trim().toLowerCase();
    const email = (c.req.query("email") ?? "").trim();
    const pid = (c.req.query("pid") ?? "").trim();
    if (!ek || !email || !pid) return c.json({ error: "ek, email, pid 파라미터가 필요합니다." }, 400);

    // PMS(KST)의 yyyyMMdd 기준. 자정 경계·시차 허용 위해 오늘/어제 모두 대조.
    const kstYmd = (offsetDays: number) => {
      const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
      return d.toISOString().slice(0, 10).replace(/-/g, "");
    };
    const expected = await Promise.all(
      [0, -1].map((o) => sha256Hex(`${email}_${pid}_${kstYmd(o)}_MALGNHELPER_PMS`)),
    );
    if (!expected.some((h) => h.toLowerCase() === ek)) {
      return c.json({ error: "유효하지 않은 PMS SSO 토큰입니다." }, 401);
    }

    const [rows] = await conn.query(
      `SELECT id, login_id, name, email, company, level, status
         FROM tb_user
        WHERE email = ? AND status = 1
        ORDER BY id
        LIMIT 1`,
      [email],
    );
    const user = (rows as any[])[0];
    if (!user) return c.json({ error: "등록된 사용자가 아닙니다." }, 403);

    const isStaff =
      (typeof user.email === "string" && user.email.endsWith("@malgnsoft.com")) ||
      user.company === "맑은소프트";
    if (!isStaff) return c.json({ error: "맑은소프트 직원 계정만 접근할 수 있습니다." }, 403);

    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      sub: user.id,
      loginId: user.login_id,
      name: user.name ?? "",
      email: user.email ?? "",
      company: user.company ?? "",
      level: user.level ?? 0,
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
    };
    const token = await jwtSign(payload, c.env.JWT_SECRET);

    return c.json({
      ok: true,
      token,
      user: {
        id: user.id,
        loginId: user.login_id,
        name: user.name,
        email: user.email,
        company: user.company,
        level: user.level,
      },
    });
  }),
);

/** POST /auth/logout — cookie 삭제 */
app.post("/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/** GET /auth/me — 현재 세션 사용자 (미인증 시 401) */
app.get("/auth/me", async (c) => {
  const token = getSessionToken(c);
  if (!token) return c.json({ error: "로그인이 필요합니다." }, 401);
  try {
    const payload = (await jwtVerify(token, c.env.JWT_SECRET)) as unknown as SessionPayload;
    return c.json({
      user: {
        id: payload.sub,
        loginId: payload.loginId,
        name: payload.name,
        email: payload.email,
        company: payload.company,
        level: payload.level,
      },
      exp: payload.exp,
    });
  } catch {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ error: "세션이 만료되었습니다. 다시 로그인해 주세요." }, 401);
  }
});

// ── 계정 관리 (admin) ────────────────────────────────────
type AccountRow = {
  id: number;
  loginId: string;
  name: string;
  email: string;
  company: string;
  level: number;
  lastLogin: string | null; // conn_date(varchar14, KST) → ISO+09:00
  isActive: boolean;         // tb_user.status === 1
};
type AccountsResponse = {
  page: number;
  pageSize: number;
  total: number;
  rows: AccountRow[];
};

/**
 * GET /accounts — 운영자/개발자/상담사 계정 목록 (admin 전용).
 * query: q(이름/로그인ID/이메일 부분검색), page(1~), pageSize(1~100, 기본 20).
 * PII(이메일)는 운영자 화면 용도로 노출. passwd 등 민감 컬럼은 select·반환 금지.
 * 고객 계정 노출 방지를 위해 직원(@malgnsoft.com 또는 company='맑은소프트')으로 스코프.
 */
app.get("/accounts", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const q = (c.req.query("q") ?? "").trim();
    const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
    const pageSizeRaw = Number(c.req.query("pageSize") ?? "20") || 20;
    const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
    const offset = (page - 1) * pageSize;

    // 직원 스코프 (고객 PII 대량 노출 방지)
    const where: string[] = ["(email LIKE ? OR company = ?)"];
    const params: (string | number)[] = ["%@malgnsoft.com", "맑은소프트"];
    if (q) {
      where.push("(name LIKE ? OR login_id LIKE ? OR email LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM tb_user ${whereSql}`,
      params,
    );
    const total = Number((countRows as { total: number }[])[0]?.total ?? 0);

    const [rows] = await conn.query(
      `SELECT id, login_id, name, email, company, level, conn_date, status
         FROM tb_user
         ${whereSql}
        ORDER BY (conn_date IS NULL), conn_date DESC, id DESC
        LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );

    const out: AccountRow[] = (rows as {
      id: number;
      login_id: string;
      name: string | null;
      email: string | null;
      company: string | null;
      level: number;
      conn_date: string | null;
      status: number;
    }[]).map((r) => ({
      id: r.id,
      loginId: r.login_id,
      name: r.name ?? "",
      email: r.email ?? "",
      company: r.company ?? "",
      level: r.level ?? 0,
      lastLogin: toIso(r.conn_date),
      isActive: r.status === 1,
    }));

    const body: AccountsResponse = { page, pageSize, total, rows: out };
    return c.json(body);
  }),
);

// ══════════════════════════════════════════════════════════
// 관리자 콘솔 — catalog(hp_topic/hp_service) · settings(hp_setting) · integrations(hp_integration)
// 테이블은 migrations/002_admin_console.sql 정의 그대로 사용(여기선 raw SQL CRUD만).
// status: 1=active, -1=deleted(soft). active: 운영 노출 토글(0/1).
// ══════════════════════════════════════════════════════════

// withConn이 넘기는 conn을 any 없이 다루기 위한 최소 인터페이스.
type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]>;
};

function isDupKey(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ER_DUP_ENTRY";
}

// 요청 body 타입(전부 optional → JSON 파싱 실패 시 {} 폴백 허용).
type TopicInput = { slug?: string; scope?: string; label?: string; description?: string; sortOrder?: number; active?: boolean };
type ServiceInput = { slug?: string; name?: string; note?: string; sortOrder?: number; active?: boolean };
type SettingsPutBody = { settings?: Record<string, unknown> };
type IntegrationPutBody = { connStatus?: string; detail?: string; config?: unknown; secretSet?: boolean };

// ── value_type 파싱/직렬화 유틸 (settings 공용) ──
type SettingValueType = "string" | "number" | "boolean" | "json";

function parseSettingValue(raw: string | null, type: string): unknown {
  if (raw === null) return null;
  switch (type) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      return raw === "true" || raw === "1";
    case "json":
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    default:
      return raw; // string
  }
}

function serializeSettingValue(value: unknown, type: string): string {
  switch (type) {
    case "number":
      return String(Number(value));
    case "boolean":
      return value ? "true" : "false";
    case "json":
      return JSON.stringify(value ?? null);
    default:
      return value == null ? "" : String(value);
  }
}

function inferValueType(value: unknown): SettingValueType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (value !== null && typeof value === "object") return "json";
  return "string";
}

// ── 토픽 카탈로그 (hp_topic) ──────────────────────────────
type TopicScope = "common" | "service";
type TopicDto = {
  id: number;
  slug: string;
  scope: TopicScope;
  label: string;
  description: string;
  sortOrder: number;
  active: boolean;
};
type TopicRaw = {
  id: number;
  slug: string;
  scope: TopicScope;
  label: string;
  description: string | null;
  sort_order: number;
  active: number;
};
function toTopicDto(r: TopicRaw): TopicDto {
  return {
    id: r.id,
    slug: r.slug,
    scope: r.scope,
    label: r.label,
    description: r.description ?? "",
    sortOrder: r.sort_order,
    active: r.active === 1,
  };
}

/** GET /topics?scope=common|service&active=1|0 — 토픽 목록(soft-deleted 제외). */
app.get("/topics", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const scope = c.req.query("scope");
    const active = c.req.query("active");
    const where: string[] = ["status = 1"];
    const params: unknown[] = [];
    if (scope === "common" || scope === "service") {
      where.push("scope = ?");
      params.push(scope);
    }
    if (active === "0" || active === "1") {
      where.push("active = ?");
      params.push(Number(active));
    }
    const [rows] = await conn.query(
      `SELECT id, slug, scope, label, description, sort_order, active
         FROM hp_topic
        WHERE ${where.join(" AND ")}
        ORDER BY scope, sort_order, id`,
      params,
    );
    return c.json({ rows: (rows as TopicRaw[]).map(toTopicDto) });
  }),
);

/** POST /topics — 토픽 생성. body {slug, scope, label, description?, sortOrder?, active?} */
app.post("/topics", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const b = await c.req.json<TopicInput>().catch((): TopicInput => ({}));
    const slug = (b.slug ?? "").trim();
    const scope = b.scope === "service" ? "service" : b.scope === "common" ? "common" : "";
    const label = (b.label ?? "").trim();
    if (!slug || !scope || !label) return c.json({ error: "slug, scope(common|service), label required" }, 400);
    try {
      const [res] = await conn.query(
        `INSERT INTO hp_topic (slug, scope, label, description, sort_order, active)
         VALUES (?,?,?,?,?,?)`,
        [slug, scope, label, b.description ?? null, Number(b.sortOrder ?? 0), b.active === false ? 0 : 1],
      );
      const id = (res as unknown as { insertId: number }).insertId;
      const [rows] = await conn.query(
        `SELECT id, slug, scope, label, description, sort_order, active FROM hp_topic WHERE id = ?`,
        [id],
      );
      return c.json(toTopicDto((rows as TopicRaw[])[0]), 201);
    } catch (e) {
      if (isDupKey(e)) return c.json({ error: "duplicate (scope, slug)" }, 409);
      throw e;
    }
  }),
);

/** PUT /topics/:id — 부분 수정(전달 필드만). active 토글 포함. */
app.put("/topics/:id", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const b = await c.req.json<TopicInput>().catch((): TopicInput => ({}));
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof b.slug === "string") { sets.push("slug = ?"); params.push(b.slug.trim()); }
    if (b.scope === "common" || b.scope === "service") { sets.push("scope = ?"); params.push(b.scope); }
    if (typeof b.label === "string") { sets.push("label = ?"); params.push(b.label.trim()); }
    if (b.description !== undefined) { sets.push("description = ?"); params.push(b.description ?? null); }
    if (b.sortOrder !== undefined) { sets.push("sort_order = ?"); params.push(Number(b.sortOrder)); }
    if (b.active !== undefined) { sets.push("active = ?"); params.push(b.active ? 1 : 0); }
    if (!sets.length) return c.json({ error: "no updatable fields" }, 400);
    try {
      const [res] = await conn.query(
        `UPDATE hp_topic SET ${sets.join(", ")} WHERE id = ? AND status = 1`,
        [...params, id],
      );
      if ((res as unknown as { affectedRows: number }).affectedRows === 0)
        return c.json({ error: "not found" }, 404);
      const [rows] = await conn.query(
        `SELECT id, slug, scope, label, description, sort_order, active FROM hp_topic WHERE id = ?`,
        [id],
      );
      return c.json(toTopicDto((rows as TopicRaw[])[0]));
    } catch (e) {
      if (isDupKey(e)) return c.json({ error: "duplicate (scope, slug)" }, 409);
      throw e;
    }
  }),
);

/** DELETE /topics/:id — soft delete(status=-1). */
app.delete("/topics/:id", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const [res] = await conn.query(`UPDATE hp_topic SET status = -1 WHERE id = ? AND status = 1`, [id]);
    if ((res as unknown as { affectedRows: number }).affectedRows === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, id });
  }),
);

// ── 서비스 카탈로그 (hp_service) ──────────────────────────
type ServiceDto = { id: number; slug: string; name: string; note: string; sortOrder: number; active: boolean };
type ServiceRaw = { id: number; slug: string; name: string; note: string | null; sort_order: number; active: number };
function toServiceDto(r: ServiceRaw): ServiceDto {
  return { id: r.id, slug: r.slug, name: r.name, note: r.note ?? "", sortOrder: r.sort_order, active: r.active === 1 };
}

/** GET /services?active=1|0 — 서비스 목록(soft-deleted 제외). */
app.get("/services", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const active = c.req.query("active");
    const where: string[] = ["status = 1"];
    const params: unknown[] = [];
    if (active === "0" || active === "1") { where.push("active = ?"); params.push(Number(active)); }
    const [rows] = await conn.query(
      `SELECT id, slug, name, note, sort_order, active
         FROM hp_service
        WHERE ${where.join(" AND ")}
        ORDER BY sort_order, id`,
      params,
    );
    return c.json({ rows: (rows as ServiceRaw[]).map(toServiceDto) });
  }),
);

/** POST /services — 생성. body {slug, name, note?, sortOrder?, active?} */
app.post("/services", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const b = await c.req.json<ServiceInput>().catch((): ServiceInput => ({}));
    const slug = (b.slug ?? "").trim();
    const name = (b.name ?? "").trim();
    if (!slug || !name) return c.json({ error: "slug, name required" }, 400);
    try {
      const [res] = await conn.query(
        `INSERT INTO hp_service (slug, name, note, sort_order, active) VALUES (?,?,?,?,?)`,
        [slug, name, b.note ?? null, Number(b.sortOrder ?? 0), b.active === false ? 0 : 1],
      );
      const id = (res as unknown as { insertId: number }).insertId;
      const [rows] = await conn.query(`SELECT id, slug, name, note, sort_order, active FROM hp_service WHERE id = ?`, [id]);
      return c.json(toServiceDto((rows as ServiceRaw[])[0]), 201);
    } catch (e) {
      if (isDupKey(e)) return c.json({ error: "duplicate slug" }, 409);
      throw e;
    }
  }),
);

/** PUT /services/:id — 부분 수정. */
app.put("/services/:id", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const b = await c.req.json<ServiceInput>().catch((): ServiceInput => ({}));
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof b.slug === "string") { sets.push("slug = ?"); params.push(b.slug.trim()); }
    if (typeof b.name === "string") { sets.push("name = ?"); params.push(b.name.trim()); }
    if (b.note !== undefined) { sets.push("note = ?"); params.push(b.note ?? null); }
    if (b.sortOrder !== undefined) { sets.push("sort_order = ?"); params.push(Number(b.sortOrder)); }
    if (b.active !== undefined) { sets.push("active = ?"); params.push(b.active ? 1 : 0); }
    if (!sets.length) return c.json({ error: "no updatable fields" }, 400);
    try {
      const [res] = await conn.query(`UPDATE hp_service SET ${sets.join(", ")} WHERE id = ? AND status = 1`, [...params, id]);
      if ((res as unknown as { affectedRows: number }).affectedRows === 0) return c.json({ error: "not found" }, 404);
      const [rows] = await conn.query(`SELECT id, slug, name, note, sort_order, active FROM hp_service WHERE id = ?`, [id]);
      return c.json(toServiceDto((rows as ServiceRaw[])[0]));
    } catch (e) {
      if (isDupKey(e)) return c.json({ error: "duplicate slug" }, 409);
      throw e;
    }
  }),
);

/** DELETE /services/:id — soft delete. */
app.delete("/services/:id", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const [res] = await conn.query(`UPDATE hp_service SET status = -1 WHERE id = ? AND status = 1`, [id]);
    if ((res as unknown as { affectedRows: number }).affectedRows === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, id });
  }),
);

// ── 외부 연동 (hp_integration) ────────────────────────────
// ⚠ 시크릿(Webhook URL·API Key·Secret 등)은 DB 저장·반환 금지. secret_set 플래그만. 실제 시크릿은 wrangler secret.
// ※ 정적 경로 "/settings/integrations" 가 파라미터 경로 "/settings/:group" 보다 먼저 등록돼야
//   매칭 우선순위가 보장된다(Hono는 등록 순서 의존) — 그래서 이 섹션을 설정 섹션보다 앞에 둔다.
type IntegrationDto = {
  id: string; // integration_key (UI 식별자)
  name: string;
  category: string;
  description: string;
  status: "connected" | "disconnected" | "error";
  detail: string;
  config: unknown; // 비밀 아닌 설정 JSON
  secretSet: boolean;
  docsUrl: string | null;
  sortOrder: number;
};
type IntegrationRaw = {
  integration_key: string;
  name: string;
  category: string;
  description: string | null;
  conn_status: "connected" | "disconnected" | "error";
  detail: string | null;
  config_json: string | null;
  secret_set: number;
  docs_url: string | null;
  sort_order: number;
};
function toIntegrationDto(r: IntegrationRaw): IntegrationDto {
  let config: unknown = null;
  if (r.config_json) {
    try { config = JSON.parse(r.config_json) as unknown; } catch { config = null; }
  }
  return {
    id: r.integration_key,
    name: r.name,
    category: r.category,
    description: r.description ?? "",
    status: r.conn_status,
    detail: r.detail ?? "",
    config,
    secretSet: r.secret_set === 1,
    docsUrl: r.docs_url,
    sortOrder: r.sort_order,
  };
}

/** GET /settings/integrations — 외부 연동 목록. 시크릿 값은 포함하지 않음. */
app.get("/settings/integrations", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const [rows] = await conn.query(
      `SELECT integration_key, name, category, description, conn_status, detail, config_json, secret_set, docs_url, sort_order
         FROM hp_integration
        WHERE status = 1
        ORDER BY sort_order, id`,
    );
    return c.json({ rows: (rows as IntegrationRaw[]).map(toIntegrationDto) });
  }),
);

/**
 * PUT /settings/integrations/:key — conn_status·detail·config(비밀 아님)·secretSet 갱신.
 * 시크릿 값 자체는 받지 않는다. 실제 시크릿은 `wrangler secret put` 로 설정.
 */
app.put("/settings/integrations/:key", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const key = c.req.param("key");
    const b = await c.req.json<IntegrationPutBody>().catch((): IntegrationPutBody => ({}));
    const sets: string[] = [];
    const params: unknown[] = [];
    if (b.connStatus === "connected" || b.connStatus === "disconnected" || b.connStatus === "error") {
      sets.push("conn_status = ?");
      params.push(b.connStatus);
    }
    if (b.detail !== undefined) { sets.push("detail = ?"); params.push(b.detail ?? null); }
    if (b.config !== undefined) { sets.push("config_json = ?"); params.push(b.config == null ? null : JSON.stringify(b.config)); }
    if (b.secretSet !== undefined) { sets.push("secret_set = ?"); params.push(b.secretSet ? 1 : 0); }
    if (!sets.length) return c.json({ error: "no updatable fields" }, 400);
    const [res] = await conn.query(
      `UPDATE hp_integration SET ${sets.join(", ")} WHERE integration_key = ? AND status = 1`,
      [...params, key],
    );
    if ((res as unknown as { affectedRows: number }).affectedRows === 0) return c.json({ error: "not found" }, 404);
    const [rows] = await conn.query(
      `SELECT integration_key, name, category, description, conn_status, detail, config_json, secret_set, docs_url, sort_order
         FROM hp_integration WHERE integration_key = ?`,
      [key],
    );
    return c.json(toIntegrationDto((rows as IntegrationRaw[])[0]));
  }),
);

// ── 설정 (hp_setting) — group: ai|safety|cache ────────────
const SETTING_GROUPS = ["ai", "safety", "cache"] as const;
type SettingGroup = (typeof SETTING_GROUPS)[number];
function isSettingGroup(g: string): g is SettingGroup {
  return (SETTING_GROUPS as readonly string[]).includes(g);
}
type SettingRaw = { setting_key: string; setting_value: string | null; value_type: string };

async function loadSettingsGroup(conn: Queryable, group: string) {
  const [rows] = await conn.query(
    `SELECT setting_key, setting_value, value_type FROM hp_setting WHERE group_name = ? AND status = 1 ORDER BY setting_key`,
    [group],
  );
  const settings: Record<string, unknown> = {};
  const valueTypes: Record<string, string> = {};
  for (const r of rows as SettingRaw[]) {
    settings[r.setting_key] = parseSettingValue(r.setting_value, r.value_type);
    valueTypes[r.setting_key] = r.value_type;
  }
  return { group, settings, valueTypes };
}

/** GET /settings/:group — ai|safety|cache 설정 묶음. setting_key(snake_case) → value_type대로 파싱된 값. */
app.get("/settings/:group", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const group = c.req.param("group");
    if (!isSettingGroup(group)) return c.json({ error: "unknown setting group (ai|safety|cache)" }, 404);
    return c.json(await loadSettingsGroup(conn, group));
  }),
);

/** PUT /settings/:group — upsert. body {settings:{<setting_key>: value, ...}} (snake_case 키, 원시 타입 값). */
app.put("/settings/:group", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const group = c.req.param("group");
    if (!isSettingGroup(group)) return c.json({ error: "unknown setting group (ai|safety|cache)" }, 404);
    const body = await c.req.json<SettingsPutBody>().catch((): SettingsPutBody => ({}));
    const incoming = body.settings;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming))
      return c.json({ error: "settings object required" }, 400);

    // 기존 키의 value_type 보존(없으면 JS 타입 추론).
    const [typeRows] = await conn.query(`SELECT setting_key, value_type FROM hp_setting WHERE group_name = ?`, [group]);
    const typeMap = new Map<string, string>();
    for (const r of typeRows as { setting_key: string; value_type: string }[]) typeMap.set(r.setting_key, r.value_type);

    const updatedBy = c.get("session").email ?? null;
    for (const key of Object.keys(incoming)) {
      const vtype = typeMap.get(key) ?? inferValueType(incoming[key]);
      const sval = serializeSettingValue(incoming[key], vtype);
      await conn.query(
        `INSERT INTO hp_setting (group_name, setting_key, setting_value, value_type, updated_by)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), value_type = VALUES(value_type),
                                 updated_by = VALUES(updated_by), status = 1`,
        [group, key, sval, vtype, updatedBy],
      );
    }
    return c.json(await loadSettingsGroup(conn, group));
  }),
);

// ── 봇 (hp_bot) — 서비스별 챗봇 페르소나·답변범위·모델 설정 ──────────
// 설계: BOTS-PLAN §3 / 스키마: migrations/004_bots.sql
// ⚠ 정적 경로 "/admin/bots" 가 파라미터 경로 "/admin/bots/:id" 보다 먼저 등록됨(아래 순서 준수).
//   JSON 컬럼(traits/refusal_topics/topics)은 LONGTEXT — 저장 시 stringify, 조회 시 parse.
//   service_id NULL = 공통(전 서비스) 봇. FK 없음 → 앱이 hp_service 존재 검증.

type BotJsonArr = string[];
function parseJsonArr(raw: string | null): BotJsonArr | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    return null;
  } catch {
    return null;
  }
}
function serializeJsonArr(value: unknown): string | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  return JSON.stringify(value.filter((x): x is string => typeof x === "string"));
}

type BotStatus = "active" | "inactive" | "draft";
type BotTone = "formal" | "friendly" | "concise";
type BotVisibility = "public" | "internal";
type BotUnknownPolicy = "strict" | "normal" | "lenient";
type BotStandardAnswerScope = "all" | "service";

function asBotStatus(v: unknown): BotStatus | null {
  return v === "active" || v === "inactive" || v === "draft" ? v : null;
}
function asBotTone(v: unknown): BotTone | null {
  return v === "formal" || v === "friendly" || v === "concise" ? v : null;
}
function asBotVisibility(v: unknown): BotVisibility | null {
  return v === "public" || v === "internal" ? v : null;
}
function asBotUnknownPolicy(v: unknown): BotUnknownPolicy | null {
  return v === "strict" || v === "normal" || v === "lenient" ? v : null;
}
function asBotScope(v: unknown): BotStandardAnswerScope | null {
  return v === "all" || v === "service" ? v : null;
}

type BotDto = {
  id: number;
  serviceId: number | null;
  serviceName: string | null; // hp_service.name 조인 (공통 봇이면 null)
  name: string;
  avatar: string | null;
  description: string | null;
  botStatus: BotStatus;
  tone: BotTone;
  traits: string[] | null;
  greeting: string | null;
  systemPrompt: string | null;
  visibility: BotVisibility;
  unknownPolicy: BotUnknownPolicy;
  escalationThreshold: number;
  refusalTopics: string[] | null;
  topics: string[] | null;
  useStandardAnswers: boolean;
  standardAnswerScope: BotStandardAnswerScope;
  model: string;
  temperature: number;
  maxTokens: number;
  createdAt: string | null;
  updatedAt: string | null;
};
type BotRaw = {
  id: number;
  service_id: number | null;
  service_name: string | null;
  name: string;
  avatar: string | null;
  description: string | null;
  bot_status: BotStatus;
  tone: BotTone;
  traits: string | null;
  greeting: string | null;
  system_prompt: string | null;
  visibility: BotVisibility;
  unknown_policy: BotUnknownPolicy;
  escalation_threshold: string | number;
  refusal_topics: string | null;
  topics: string | null;
  use_standard_answers: number;
  standard_answer_scope: BotStandardAnswerScope;
  model: string;
  temperature: string | number;
  max_tokens: number;
  created_at: string | null;
  updated_at: string | null;
};
function toBotDto(r: BotRaw): BotDto {
  return {
    id: r.id,
    serviceId: r.service_id,
    serviceName: r.service_name,
    name: r.name,
    avatar: r.avatar,
    description: r.description,
    botStatus: r.bot_status,
    tone: r.tone,
    traits: parseJsonArr(r.traits),
    greeting: r.greeting,
    systemPrompt: r.system_prompt,
    visibility: r.visibility,
    unknownPolicy: r.unknown_policy,
    escalationThreshold: Number(r.escalation_threshold),
    refusalTopics: parseJsonArr(r.refusal_topics),
    topics: parseJsonArr(r.topics),
    useStandardAnswers: r.use_standard_answers === 1,
    standardAnswerScope: r.standard_answer_scope,
    model: r.model,
    temperature: Number(r.temperature),
    maxTokens: r.max_tokens,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// 단건 조회 공통 SELECT(서비스명 조인). 소프트삭제 행은 제외하지 않음(직후 조회는 status 무관 id 단건).
const BOT_SELECT = `
  SELECT b.id, b.service_id, s.name AS service_name, b.name, b.avatar, b.description, b.bot_status,
         b.tone, b.traits, b.greeting, b.system_prompt, b.visibility, b.unknown_policy,
         b.escalation_threshold, b.refusal_topics, b.topics, b.use_standard_answers,
         b.standard_answer_scope, b.model, b.temperature, b.max_tokens, b.created_at, b.updated_at
    FROM hp_bot b
    LEFT JOIN hp_service s ON s.id = b.service_id AND s.status = 1`;

type BotInput = {
  serviceId?: number | null;
  name?: string;
  avatar?: string | null;
  description?: string | null;
  botStatus?: string;
  tone?: string;
  traits?: unknown;
  greeting?: string | null;
  systemPrompt?: string | null;
  visibility?: string;
  unknownPolicy?: string;
  escalationThreshold?: number;
  refusalTopics?: unknown;
  topics?: unknown;
  useStandardAnswers?: boolean;
  standardAnswerScope?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

// service_id 존재 검증(NULL=공통 허용). 유효하지 않으면 false.
async function serviceIdExists(conn: Queryable, serviceId: number): Promise<boolean> {
  const [rows] = await conn.query(`SELECT id FROM hp_service WHERE id = ? AND status = 1 LIMIT 1`, [serviceId]);
  return (rows as unknown[]).length > 0;
}

/**
 * GET /admin/bots?service_id=&bot_status=&limit=&offset= — 봇 목록(soft-deleted 제외).
 * service_id 필터: 숫자=해당 서비스 / "common"(또는 빈값) = 공통(service_id IS NULL).
 * 빈값(미지정)은 필터 없음(전체). 응답 {total,limit,offset,rows}.
 */
app.get("/admin/bots", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const where: string[] = ["b.status = 1"];
    const params: unknown[] = [];

    // service_id 필터: "common" → IS NULL, 숫자 → = ?, 그 외/빈값 → 필터 없음(전체).
    const sidRaw = c.req.query("service_id");
    if (sidRaw === "common") {
      where.push("b.service_id IS NULL");
    } else if (sidRaw !== undefined && sidRaw !== "") {
      const sid = Number(sidRaw);
      if (!Number.isInteger(sid)) return c.json({ error: "invalid service_id (number|common)" }, 400);
      where.push("b.service_id = ?");
      params.push(sid);
    }

    const botStatus = c.req.query("bot_status");
    if (asBotStatus(botStatus)) {
      where.push("b.bot_status = ?");
      params.push(botStatus);
    }

    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const whereSql = where.join(" AND ");

    const [countRows] = await conn.query(`SELECT COUNT(*) AS cnt FROM hp_bot b WHERE ${whereSql}`, params);
    const total = Number((countRows as { cnt: number }[])[0]?.cnt ?? 0);

    const [rows] = await conn.query(
      `${BOT_SELECT} WHERE ${whereSql} ORDER BY b.service_id IS NULL DESC, b.service_id, b.id LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return c.json({ total, limit, offset, rows: (rows as BotRaw[]).map(toBotDto) });
  }),
);

/** GET /admin/bots/:id — 단건(JSON 역직렬화). soft-deleted 제외. */
app.get("/admin/bots/:id", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const [rows] = await conn.query(`${BOT_SELECT} WHERE b.id = ? AND b.status = 1`, [id]);
    const r = (rows as BotRaw[])[0];
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(toBotDto(r));
  }),
);

/** POST /admin/bots — 생성. name 필수. service_id는 NULL(공통) 또는 존재하는 hp_service.id만. */
app.post("/admin/bots", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const b = await c.req.json<BotInput>().catch((): BotInput => ({}));
    const name = (b.name ?? "").trim();
    if (!name) return c.json({ error: "name required" }, 400);

    // service_id 검증: undefined/null → 공통(NULL). 숫자면 hp_service 존재 확인.
    let serviceId: number | null = null;
    if (b.serviceId !== undefined && b.serviceId !== null) {
      const sid = Number(b.serviceId);
      if (!Number.isInteger(sid)) return c.json({ error: "invalid serviceId" }, 400);
      if (!(await serviceIdExists(conn, sid))) return c.json({ error: "serviceId not found" }, 400);
      serviceId = sid;
    }

    // ENUM 값 검증(잘못된 값은 400). 미지정은 DB DEFAULT 사용.
    const botStatus = b.botStatus === undefined ? "draft" : asBotStatus(b.botStatus);
    if (botStatus === null) return c.json({ error: "invalid botStatus (active|inactive|draft)" }, 400);
    const tone = b.tone === undefined ? "friendly" : asBotTone(b.tone);
    if (tone === null) return c.json({ error: "invalid tone (formal|friendly|concise)" }, 400);
    const visibility = b.visibility === undefined ? "public" : asBotVisibility(b.visibility);
    if (visibility === null) return c.json({ error: "invalid visibility (public|internal)" }, 400);
    const unknownPolicy = b.unknownPolicy === undefined ? "strict" : asBotUnknownPolicy(b.unknownPolicy);
    if (unknownPolicy === null) return c.json({ error: "invalid unknownPolicy (strict|normal|lenient)" }, 400);
    const scope = b.standardAnswerScope === undefined ? "all" : asBotScope(b.standardAnswerScope);
    if (scope === null) return c.json({ error: "invalid standardAnswerScope (all|service)" }, 400);

    const [res] = await conn.query(
      `INSERT INTO hp_bot
         (service_id, name, avatar, description, bot_status, tone, traits, greeting, system_prompt,
          visibility, unknown_policy, escalation_threshold, refusal_topics, topics,
          use_standard_answers, standard_answer_scope, model, temperature, max_tokens)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        serviceId,
        name,
        b.avatar ?? null,
        b.description ?? null,
        botStatus,
        tone,
        serializeJsonArr(b.traits),
        b.greeting ?? null,
        b.systemPrompt ?? null,
        visibility,
        unknownPolicy,
        b.escalationThreshold === undefined ? 0.5 : Number(b.escalationThreshold),
        serializeJsonArr(b.refusalTopics),
        serializeJsonArr(b.topics),
        b.useStandardAnswers === false ? 0 : 1,
        scope,
        (b.model ?? "openai/gpt-4.1-mini").trim() || "openai/gpt-4.1-mini",
        b.temperature === undefined ? 0.3 : Number(b.temperature),
        b.maxTokens === undefined ? 2048 : Number(b.maxTokens),
      ],
    );
    const id = (res as unknown as { insertId: number }).insertId;
    const [rows] = await conn.query(`${BOT_SELECT} WHERE b.id = ?`, [id]);
    return c.json(toBotDto((rows as BotRaw[])[0]), 201);
  }),
);

/** PATCH /admin/bots/:id — 부분 수정(전달 필드만). updated_at는 ON UPDATE로 자동 갱신. */
app.patch("/admin/bots/:id", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const b = await c.req.json<BotInput>().catch((): BotInput => ({}));
    const sets: string[] = [];
    const params: unknown[] = [];

    if (b.serviceId !== undefined) {
      if (b.serviceId === null) {
        sets.push("service_id = ?");
        params.push(null);
      } else {
        const sid = Number(b.serviceId);
        if (!Number.isInteger(sid)) return c.json({ error: "invalid serviceId" }, 400);
        if (!(await serviceIdExists(conn, sid))) return c.json({ error: "serviceId not found" }, 400);
        sets.push("service_id = ?");
        params.push(sid);
      }
    }
    if (typeof b.name === "string") {
      const name = b.name.trim();
      if (!name) return c.json({ error: "name cannot be empty" }, 400);
      sets.push("name = ?"); params.push(name);
    }
    if (b.avatar !== undefined) { sets.push("avatar = ?"); params.push(b.avatar ?? null); }
    if (b.description !== undefined) { sets.push("description = ?"); params.push(b.description ?? null); }
    if (b.botStatus !== undefined) {
      const v = asBotStatus(b.botStatus);
      if (v === null) return c.json({ error: "invalid botStatus (active|inactive|draft)" }, 400);
      sets.push("bot_status = ?"); params.push(v);
    }
    if (b.tone !== undefined) {
      const v = asBotTone(b.tone);
      if (v === null) return c.json({ error: "invalid tone (formal|friendly|concise)" }, 400);
      sets.push("tone = ?"); params.push(v);
    }
    if (b.traits !== undefined) { sets.push("traits = ?"); params.push(serializeJsonArr(b.traits)); }
    if (b.greeting !== undefined) { sets.push("greeting = ?"); params.push(b.greeting ?? null); }
    if (b.systemPrompt !== undefined) { sets.push("system_prompt = ?"); params.push(b.systemPrompt ?? null); }
    if (b.visibility !== undefined) {
      const v = asBotVisibility(b.visibility);
      if (v === null) return c.json({ error: "invalid visibility (public|internal)" }, 400);
      sets.push("visibility = ?"); params.push(v);
    }
    if (b.unknownPolicy !== undefined) {
      const v = asBotUnknownPolicy(b.unknownPolicy);
      if (v === null) return c.json({ error: "invalid unknownPolicy (strict|normal|lenient)" }, 400);
      sets.push("unknown_policy = ?"); params.push(v);
    }
    if (b.escalationThreshold !== undefined) { sets.push("escalation_threshold = ?"); params.push(Number(b.escalationThreshold)); }
    if (b.refusalTopics !== undefined) { sets.push("refusal_topics = ?"); params.push(serializeJsonArr(b.refusalTopics)); }
    if (b.topics !== undefined) { sets.push("topics = ?"); params.push(serializeJsonArr(b.topics)); }
    if (b.useStandardAnswers !== undefined) { sets.push("use_standard_answers = ?"); params.push(b.useStandardAnswers ? 1 : 0); }
    if (b.standardAnswerScope !== undefined) {
      const v = asBotScope(b.standardAnswerScope);
      if (v === null) return c.json({ error: "invalid standardAnswerScope (all|service)" }, 400);
      sets.push("standard_answer_scope = ?"); params.push(v);
    }
    if (b.model !== undefined) {
      const m = (b.model ?? "").trim();
      if (!m) return c.json({ error: "model cannot be empty" }, 400);
      sets.push("model = ?"); params.push(m);
    }
    if (b.temperature !== undefined) { sets.push("temperature = ?"); params.push(Number(b.temperature)); }
    if (b.maxTokens !== undefined) { sets.push("max_tokens = ?"); params.push(Number(b.maxTokens)); }

    if (!sets.length) return c.json({ error: "no updatable fields" }, 400);
    const [res] = await conn.query(
      `UPDATE hp_bot SET ${sets.join(", ")} WHERE id = ? AND status = 1`,
      [...params, id],
    );
    if ((res as unknown as { affectedRows: number }).affectedRows === 0) return c.json({ error: "not found" }, 404);
    const [rows] = await conn.query(`${BOT_SELECT} WHERE b.id = ?`, [id]);
    return c.json(toBotDto((rows as BotRaw[])[0]));
  }),
);

/** DELETE /admin/bots/:id — soft delete(status=-1). */
app.delete("/admin/bots/:id", requireAuth, requireRole(ROLE_LEVEL.admin), async (c) =>
  withConn(c, async (conn) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const [res] = await conn.query(`UPDATE hp_bot SET status = -1 WHERE id = ? AND status = 1`, [id]);
    if ((res as unknown as { affectedRows: number }).affectedRows === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, id });
  }),
);

// ── 학습 자료 (hp_material · 008 마이그레이션) ──────────────────────────────
// 정본: malgn-helper-mng/docs/HP-SCHEMA.md (학습 자료 절) + migrations/008_material.sql
// 챗봇 지식 소스(파일/URL/텍스트/Q&A) 카탈로그. file 은 R2 원본 보관(r2_key), 본문은 extracted_text 에 추출.
//
// ⚠ OpenSearch/벡터 색인은 범위 밖(현 인프라 부재) — 여기서 "색인"=extracted_text 저장 + LIKE 검색(MVP).
//    본문 추출 지원 형식(text/*·md·txt·csv·html·url·text·qa)만 indexed, 그 외(pdf/docx/이미지/영상)는 stored.
//    → OpenSearch 전환 대상: extracted_text 를 BM25/벡터 색인으로 승격(향후 009+).
//
// ⚠ graceful degrade: 008 미적용(테이블 부재)이면 목록=빈 배열, 쓰기 계열=503(워커 500 금지).
//    isolate 단위 lazy 캐시 — 첫 요청 시 INFORMATION_SCHEMA 로 1회 확인. 적용 후 재배포로 갱신.
type MaterialType = "file" | "url" | "text" | "qa";
type MaterialIndexStatus = "processing" | "indexed" | "stored" | "failed";
const MATERIAL_TYPES: readonly MaterialType[] = ["file", "url", "text", "qa"];
const MATERIAL_INDEX_STATUSES: readonly MaterialIndexStatus[] = ["processing", "indexed", "stored", "failed"];
const isMaterialType = (s: string): s is MaterialType => (MATERIAL_TYPES as readonly string[]).includes(s);
const isMaterialIndexStatus = (s: string): s is MaterialIndexStatus =>
  (MATERIAL_INDEX_STATUSES as readonly string[]).includes(s);

let _materialTableChecked = false;
let _materialTableExists = false;
async function materialTableExists(conn: Queryable): Promise<boolean> {
  if (_materialTableChecked) return _materialTableExists;
  try {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hp_material' LIMIT 1`,
    );
    _materialTableExists = (rows as unknown[]).length > 0;
  } catch {
    _materialTableExists = false; // 조회 실패 시에도 워커는 500 없이 degrade.
  }
  _materialTableChecked = true;
  return _materialTableExists;
}
const MATERIAL_TABLE_MISSING = { error: "학습 자료 테이블 미적용(008)" } as const;
const MATERIAL_STORED_SUMMARY = "(본문 추출 미지원 형식 — 저장됨)";
const MATERIAL_MAX_EXTRACT = 5_000_000; // 추출 텍스트 상한 5MB(MEDIUMTEXT 16MB 이내 방어).
const MATERIAL_PREVIEW_LEN = 20_000; // 상세 응답 extracted_text 프리뷰 길이.

/** 안전 파일명 — 경로 구분자·제어문자 제거, 공백→_, 200자 제한. */
function safeMaterialFilename(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // 제어문자 + 파일시스템/헤더 위험 문자 제거.
    .replace(/[\u0000-\u001f<>:"|?*\\\/]+/g, "")
    .replace(/\s+/g, "_")
    .trim();
  return (cleaned || "file").slice(0, 200);
}

/** R2 오브젝트 키 — materials/<timestamp>-<random>/<safe filename>. */
function materialR2Key(filename: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `materials/${Date.now()}-${rand}/${safeMaterialFilename(filename)}`;
}

/** 본문 텍스트 추출 지원 여부 — mime text/* 또는 확장자 md/txt/csv/html. */
function isTextExtractable(mime: string, filename: string): boolean {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("text/")) return true;
  const ext = (String(filename).split(".").pop() ?? "").toLowerCase();
  return ["md", "markdown", "txt", "csv", "html", "htm"].includes(ext);
}

/** 표시용 포맷 도출 — 확장자 우선, 없으면 mime 계열. */
function deriveFileFormat(filename: string, mime: string): string {
  const ext = (String(filename).split(".").pop() ?? "").toLowerCase();
  if (ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext)) return ext.toUpperCase();
  const m = (mime || "").toLowerCase();
  if (m.includes("pdf")) return "PDF";
  if (m.startsWith("image/")) return (m.split("/")[1] ?? "image").toUpperCase();
  if (m.startsWith("text/")) return "TXT";
  return "FILE";
}

type MaterialExtraction = {
  extractedText: string;
  summary: string;
  chunks: number;
  indexStatus: MaterialIndexStatus;
};

/** 추출 본문 → summary(앞 300자)·chunks(≈len/1000)·indexed. 색인=extracted_text 저장(LIKE MVP). */
function buildMaterialExtraction(rawText: string): MaterialExtraction {
  const text = (rawText ?? "").slice(0, MATERIAL_MAX_EXTRACT);
  const len = text.length;
  return {
    extractedText: text,
    summary: text.slice(0, 300),
    chunks: len > 0 ? Math.ceil(len / 1000) : 0,
    indexStatus: "indexed",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RAG(의미검색) — 문서 본문 추출(toMarkdown) → 청크 임베딩(bge-m3) → Vectorize 색인.
// ─────────────────────────────────────────────────────────────────────────────
const MATERIAL_EMBED_MODEL = "@cf/baai/bge-m3"; // 1024-dim, 다국어(한국어 OK)
const MATERIAL_CHUNK_SIZE = 800; // 청크 목표 길이(문자)
const MATERIAL_CHUNK_OVERLAP = 100; // 인접 청크 겹침(문맥 보존)
const MATERIAL_MAX_CHUNKS = 2000; // 자료당 벡터 상한(런어웨이 방어)
const MATERIAL_EMBED_BATCH = 100; // bge-m3 입력 배열 1회 상한(초과 시 분할 호출)
const MATERIAL_VECTOR_BATCH = 200; // Vectorize upsert/delete 1회 배치

/** vector id — m{materialId}-{chunkIndex}. deleteByIds 로 자료 단위 정리. */
function materialVectorId(materialId: number, chunk: number): string {
  return `m${materialId}-${chunk}`;
}

/** Vectorize 바인딩 가용 여부 — 미바인딩/런타임 미주입 시 안전 스킵. */
function vectorizeAvailable(env: Bindings): boolean {
  const v = env.VECTORIZE as unknown as { query?: unknown; upsert?: unknown } | undefined;
  return !!v && typeof v.upsert === "function" && typeof v.query === "function";
}

/**
 * 본문 → ~800자 청크(문단 경계 우선, 100자 overlap). 긴 문단은 하드 분할.
 * 최대 MATERIAL_MAX_CHUNKS 개까지만 생성(초과분 절단).
 */
function chunkText(text: string): string[] {
  const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const size = MATERIAL_CHUNK_SIZE;
  const overlap = MATERIAL_CHUNK_OVERLAP;
  const chunks: string[] = [];
  let cur = "";
  const push = (s: string) => {
    const t = s.trim();
    if (t) chunks.push(t);
  };
  for (const p of paras) {
    if (chunks.length >= MATERIAL_MAX_CHUNKS) break;
    if (p.length > size) {
      if (cur) { push(cur); cur = ""; }
      // 긴 문단 하드 분할(overlap 유지).
      for (let i = 0; i < p.length && chunks.length < MATERIAL_MAX_CHUNKS; i += size - overlap) {
        push(p.slice(i, i + size));
      }
      continue;
    }
    if (cur && cur.length + 1 + p.length > size) {
      push(cur);
      const tail = cur.slice(Math.max(0, cur.length - overlap));
      cur = `${tail}\n${p}`;
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
  }
  if (cur && chunks.length < MATERIAL_MAX_CHUNKS) push(cur);
  return chunks.slice(0, MATERIAL_MAX_CHUNKS);
}

/**
 * Workers AI toMarkdown 로 파일 본문 추출(pdf·docx·pptx·xlsx·이미지 등).
 * 실패/미지원 mime 는 throw → 호출부에서 stored 로 폴백.
 */
async function extractViaToMarkdown(
  env: Bindings,
  filename: string,
  buf: ArrayBuffer,
  mime: string,
): Promise<string> {
  const ai = env.AI as unknown as { toMarkdown?: unknown };
  if (!ai || typeof ai.toMarkdown !== "function") throw new Error("toMarkdown 미지원(AI 바인딩)");
  const blob = new Blob([buf], { type: mime || "application/octet-stream" });
  const name = safeMaterialFilename(filename) || "file";
  const res = await env.AI.toMarkdown([{ name, blob }]);
  const first = Array.isArray(res) ? res[0] : res;
  if (!first) throw new Error("toMarkdown 응답 없음");
  if (first.format === "error") throw new Error(first.error || "toMarkdown 변환 실패");
  const data = typeof (first as { data?: unknown }).data === "string" ? (first as { data: string }).data : "";
  if (!data.trim()) throw new Error("toMarkdown 결과 비어 있음");
  return data;
}

/** 자료 벡터 삭제 — m{id}-0..count-1(배치). Vectorize 미가용/실패는 무시(로깅). */
async function deleteMaterialVectors(env: Bindings, materialId: number, count: number): Promise<void> {
  if (!vectorizeAvailable(env)) return;
  const n = Math.max(0, Math.min(Number(count) || 0, MATERIAL_MAX_CHUNKS));
  if (n === 0) return;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(materialVectorId(materialId, i));
  try {
    for (let s = 0; s < ids.length; s += MATERIAL_VECTOR_BATCH) {
      await env.VECTORIZE.deleteByIds(ids.slice(s, s + MATERIAL_VECTOR_BATCH));
    }
  } catch (e) {
    console.warn(`[material ${materialId}] 벡터 삭제 실패: ${(e as Error).message}`);
  }
}

/**
 * 본문 청크 임베딩 → Vectorize upsert. 재색인 시 이전 벡터(prevChunks 범위)를 먼저 정리.
 * 반환 chunks = 실제 upsert 된 벡터 수. 임베딩/색인 실패는 vectorError 로만 보고(자료 저장은 성공 유지).
 */
async function indexMaterialVectors(
  env: Bindings,
  materialId: number,
  name: string,
  text: string,
  prevChunks: number,
): Promise<{ chunks: number; vectorError: string | null }> {
  const pieces = chunkText(text);
  if (!vectorizeAvailable(env)) {
    return { chunks: pieces.length, vectorError: "Vectorize 미바인딩 — 색인 스킵" };
  }
  // 이전 벡터 정리(축소·재색인 대비): prev∪new 최대치 범위 삭제 후 재upsert.
  await deleteMaterialVectors(env, materialId, Math.max(Number(prevChunks) || 0, pieces.length));
  if (pieces.length === 0) return { chunks: 0, vectorError: null };

  try {
    const vectors: VectorizeVector[] = [];
    for (let start = 0; start < pieces.length; start += MATERIAL_EMBED_BATCH) {
      const batch = pieces.slice(start, start + MATERIAL_EMBED_BATCH);
      const out = (await env.AI.run(MATERIAL_EMBED_MODEL, { text: batch })) as unknown as {
        data?: number[][];
      };
      const emb = out?.data ?? [];
      for (let j = 0; j < batch.length; j++) {
        const values = emb[j];
        if (!Array.isArray(values) || values.length === 0) continue;
        const idx = start + j;
        vectors.push({
          id: materialVectorId(materialId, idx),
          values,
          metadata: {
            materialId,
            chunk: idx,
            name: name.slice(0, 200),
            snippet: batch[j].slice(0, 240),
          },
        });
      }
    }
    if (vectors.length === 0) return { chunks: 0, vectorError: "임베딩 결과 없음" };
    for (let s = 0; s < vectors.length; s += MATERIAL_VECTOR_BATCH) {
      await env.VECTORIZE.upsert(vectors.slice(s, s + MATERIAL_VECTOR_BATCH));
    }
    return { chunks: vectors.length, vectorError: null };
  } catch (e) {
    const msg = `벡터 색인 실패: ${(e as Error).message}`.slice(0, 300);
    console.warn(`[material ${materialId}] ${msg}`);
    // 색인 실패해도 자료 저장 자체는 성공 — chunks 는 의도 청크 수 유지.
    return { chunks: pieces.length, vectorError: msg };
  }
}

/** tags/services 입력 정규화 — 배열/JSON 문자열/콤마 문자열 모두 허용 → 문자열 배열(최대 50). */
function normalizeMaterialStringArray(input: unknown): string[] {
  const clamp = (arr: unknown[]): string[] =>
    arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
  if (Array.isArray(input)) return clamp(input);
  if (typeof input === "string" && input.trim()) {
    const s = input.trim();
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) return clamp(parsed);
    } catch {
      /* JSON 아님 — 콤마 분할로 폴백 */
    }
    return clamp(s.split(","));
  }
  return [];
}

/** 문자열 배열 → DB 저장용 JSON 문자열(빈배열이면 null). */
function materialArrayToJson(arr: string[]): string | null {
  return arr.length ? JSON.stringify(arr) : null;
}

/** DB TEXT(JSON) → 문자열 배열(파싱 실패 시 빈배열). */
function parseMaterialJsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

type MaterialRow = {
  id: number;
  name: string;
  type: string;
  source: string | null;
  format: string | null;
  r2_key: string | null;
  mime: string | null;
  size_bytes: number | string | null;
  index_status: string;
  summary: string | null;
  extracted_text?: string | null;
  chunks: number;
  tags: string | null;
  services: string | null;
  error?: string | null;
  created_by: string | null;
  created_at: unknown;
  updated_at?: unknown;
};

/** 목록/공통 DTO — admin 소비용 camelCase. extracted_text 는 제외(상세에서 프리뷰 제공). */
function toMaterialListDto(r: MaterialRow) {
  const id = Number(r.id);
  return {
    id,
    name: r.name,
    type: r.type,
    source: r.source,
    format: r.format,
    mime: r.mime,
    sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
    indexStatus: r.index_status,
    summary: r.summary,
    chunks: Number(r.chunks ?? 0),
    tags: parseMaterialJsonArray(r.tags),
    services: parseMaterialJsonArray(r.services),
    downloadPath: r.type === "file" && r.r2_key ? `/materials/${id}/download` : null,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

// POST /materials — 자료 등록. multipart(file) 또는 JSON(url|text|qa).
//   Hyperdrive SELECT 캐시로 등록 직후 GET 이 stale 일 수 있어 응답에 등록 행을 echo(재-GET 불필요).
app.post("/materials", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    if (!(await materialTableExists(conn))) return c.json(MATERIAL_TABLE_MISSING, 503);
    const createdBy = c.get("session")?.loginId ?? null;
    const contentType = (c.req.header("content-type") || "").toLowerCase();

    let name = "";
    let type: MaterialType;
    let source: string | null = null;
    let format: string | null = null;
    let r2Key: string | null = null;
    let mime: string | null = null;
    let sizeBytes: number | null = null;
    let extractedText: string | null = null;
    let summary: string | null = null;
    let chunks = 0;
    let indexStatus: MaterialIndexStatus = "processing";
    let error: string | null = null;
    let tags: string[] = [];
    let services: string[] = [];

    if (contentType.includes("multipart/form-data")) {
      // ── 파일 업로드 ──
      let body: Record<string, string | File | (string | File)[]>;
      try {
        body = await c.req.parseBody();
      } catch {
        return c.json({ error: "multipart 파싱 실패" }, 400);
      }
      const file = body["file"];
      if (!(file instanceof File)) return c.json({ error: "file 필드(업로드 파일)가 필요합니다." }, 400);
      type = "file";
      const rawName = file.name || "file";
      const nameField = body["name"];
      const sourceField = body["source"];
      name = (typeof nameField === "string" && nameField.trim()) || rawName;
      source = (typeof sourceField === "string" && sourceField.trim()) || rawName;
      mime = file.type || "application/octet-stream";
      tags = normalizeMaterialStringArray(body["tags"]);
      services = normalizeMaterialStringArray(body["services"]);
      format = deriveFileFormat(rawName, mime);

      const buf = await file.arrayBuffer();
      sizeBytes = buf.byteLength;
      r2Key = materialR2Key(rawName);
      await c.env.R2.put(r2Key, buf, { httpMetadata: { contentType: mime } });

      if (isTextExtractable(mime, rawName)) {
        try {
          const decoded = new TextDecoder().decode(buf);
          const isHtml = /html/.test(mime) || /\.html?$/i.test(rawName);
          const ext = buildMaterialExtraction(isHtml ? htmlToParagraphs(decoded) : decoded);
          extractedText = ext.extractedText;
          summary = ext.summary;
          chunks = ext.chunks;
          indexStatus = ext.indexStatus;
        } catch {
          indexStatus = "stored";
          summary = MATERIAL_STORED_SUMMARY;
        }
      } else {
        // pdf·docx·pptx·xlsx·이미지 등 — Workers AI toMarkdown 으로 본문 추출.
        try {
          const md = await extractViaToMarkdown(c.env, rawName, buf, mime);
          const ext = buildMaterialExtraction(md);
          extractedText = ext.extractedText;
          summary = ext.summary;
          chunks = ext.chunks;
          indexStatus = ext.indexStatus;
        } catch (e) {
          indexStatus = "stored";
          summary = MATERIAL_STORED_SUMMARY;
          error = `본문 추출 실패(toMarkdown): ${(e as Error).message}`.slice(0, 500);
        }
      }
    } else {
      // ── JSON (url | text | qa) ──
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return c.json({ error: "JSON 본문 파싱 실패" }, 400);
      }
      const t = String(body.type ?? "").trim();
      if (t === "file" || !isMaterialType(t)) {
        return c.json({ error: "type 은 url|text|qa 중 하나여야 합니다(file 은 multipart 업로드)." }, 400);
      }
      type = t;
      tags = normalizeMaterialStringArray(body.tags);
      services = normalizeMaterialStringArray(body.services);
      const nameIn = typeof body.name === "string" ? body.name.trim() : "";
      const sourceIn = typeof body.source === "string" ? body.source.trim() : "";

      if (type === "url") {
        const url = (typeof body.url === "string" ? body.url : sourceIn).trim();
        if (!/^https?:\/\//i.test(url)) return c.json({ error: "유효한 url 이 필요합니다(http/https)." }, 400);
        source = url;
        format = "URL";
        name = nameIn || url;
        try {
          const res = await fetch(url, {
            headers: { "User-Agent": "malgn-helper-material/1.0" },
            redirect: "follow",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const ext = buildMaterialExtraction(htmlToParagraphs(await res.text()));
          extractedText = ext.extractedText;
          summary = ext.summary;
          chunks = ext.chunks;
          indexStatus = ext.indexStatus;
        } catch (e) {
          indexStatus = "stored";
          summary = "(URL 본문 추출 실패 — 출처만 저장됨)";
          error = `fetch 실패: ${(e as Error).message}`.slice(0, 500);
        }
      } else if (type === "text") {
        const text = String(body.text ?? body.content ?? "").trim();
        if (!text) return c.json({ error: "text(본문)이 필요합니다." }, 400);
        source = sourceIn || null;
        format = "TEXT";
        name = nameIn || text.slice(0, 40);
        const ext = buildMaterialExtraction(text);
        extractedText = ext.extractedText;
        summary = ext.summary;
        chunks = ext.chunks;
        indexStatus = ext.indexStatus;
      } else {
        // qa — question/answer 결합, 없으면 text.
        const question = String(body.question ?? "").trim();
        const answer = String(body.answer ?? "").trim();
        const combined =
          question || answer ? `Q: ${question}\nA: ${answer}`.trim() : String(body.text ?? "").trim();
        if (!combined) return c.json({ error: "question/answer 또는 text 가 필요합니다." }, 400);
        source = sourceIn || null;
        format = "Q&A";
        name = nameIn || (question ? question.slice(0, 60) : combined.slice(0, 40));
        const ext = buildMaterialExtraction(combined);
        extractedText = ext.extractedText;
        summary = ext.summary;
        chunks = ext.chunks;
        indexStatus = ext.indexStatus;
      }
    }

    name = (name || "(제목 없음)").slice(0, 200);

    const [ins] = await conn.query(
      `INSERT INTO hp_material
         (name, type, source, format, r2_key, mime, size_bytes, index_status,
          summary, extracted_text, chunks, tags, services, error, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        name,
        type,
        source,
        format,
        r2Key,
        mime,
        sizeBytes,
        indexStatus,
        summary,
        extractedText,
        chunks,
        materialArrayToJson(tags),
        materialArrayToJson(services),
        error,
        createdBy,
      ],
    );
    const id = Number((ins as unknown as { insertId: number }).insertId);

    // 본문 추출 성공(indexed) 시 청크 임베딩 → Vectorize 색인. 실패해도 자료 저장은 성공(색인만 스킵).
    if (indexStatus === "indexed" && extractedText) {
      const rv = await indexMaterialVectors(c.env, id, name, extractedText, 0);
      const mergedError = rv.vectorError ?? error;
      if (rv.chunks !== chunks || mergedError !== error) {
        chunks = rv.chunks;
        error = mergedError;
        await conn.query(
          `UPDATE hp_material SET chunks = ?, error = ?, updated_at = NOW() WHERE id = ?`,
          [chunks, error, id],
        );
      }
    }

    return c.json({
      ok: true,
      id,
      name,
      type,
      source,
      format,
      mime,
      sizeBytes,
      indexStatus,
      summary,
      chunks,
      tags,
      services,
      error,
      downloadPath: type === "file" && r2Key ? `/materials/${id}/download` : null,
      createdBy,
    });
  }),
);

// GET /materials — 목록. 필터 type·indexStatus·search(name/source/extracted_text LIKE)·limit/offset. status=1.
app.get("/materials", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    if (!(await materialTableExists(conn))) return c.json({ total: 0, limit: 0, offset: 0, rows: [] });
    const limit = Math.min(parseInt(c.req.query("limit") ?? "30", 10) || 30, 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const search = (c.req.query("search") ?? "").trim();
    const type = (c.req.query("type") ?? "").trim();
    const indexStatus = (c.req.query("indexStatus") ?? "").trim();

    const where: string[] = ["status = 1"];
    const params: unknown[] = [];
    if (isMaterialType(type)) {
      where.push("type = ?");
      params.push(type);
    }
    if (isMaterialIndexStatus(indexStatus)) {
      where.push("index_status = ?");
      params.push(indexStatus);
    }
    if (search) {
      where.push("(name LIKE ? OR source LIKE ? OR extracted_text LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [countRows] = await conn.query(`SELECT COUNT(*) AS total FROM hp_material ${whereSql}`, params);
    const total = Number((countRows as { total: number }[])[0]?.total ?? 0);

    const [rows] = await conn.query(
      `SELECT id, name, type, source, format, r2_key, mime, size_bytes, index_status,
              summary, chunks, tags, services, created_by, created_at
         FROM hp_material ${whereSql}
     ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return c.json({ total, limit, offset, rows: (rows as MaterialRow[]).map(toMaterialListDto) });
  }),
);

// GET /materials/:id/download — R2 원본 스트리밍(권한 체크). <a href> 접근 대비 쿠키 세션 폴백 동작.
app.get("/materials/:id/download", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    if (!(await materialTableExists(conn))) return c.json(MATERIAL_TABLE_MISSING, 503);
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const [rows] = await conn.query(
      `SELECT name, r2_key, mime FROM hp_material WHERE id = ? AND status = 1 AND type = 'file'`,
      [id],
    );
    const r = (rows as { name: string; r2_key: string | null; mime: string | null }[])[0];
    if (!r || !r.r2_key) return c.json({ error: "not found" }, 404);
    const obj = await c.env.R2.get(r.r2_key);
    if (!obj) return c.json({ error: "R2 object not found" }, 404);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("Content-Type", r.mime || obj.httpMetadata?.contentType || "application/octet-stream");
    headers.set("Content-Length", String(obj.size));
    headers.set("Cache-Control", "private, no-store");
    const filename = safeMaterialFilename(r.name || `material-${id}`);
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return new Response(obj.body, { headers });
  }),
);

// POST /materials/:id/reindex — 저장 원본/URL/텍스트로 추출 재시도. index_status·summary·chunks 갱신.
app.post("/materials/:id/reindex", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    if (!(await materialTableExists(conn))) return c.json(MATERIAL_TABLE_MISSING, 503);
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const [rows] = await conn.query(
      `SELECT id, name, type, source, r2_key, mime, extracted_text, chunks
         FROM hp_material WHERE id = ? AND status = 1`,
      [id],
    );
    const r = (rows as {
      id: number;
      name: string;
      type: string;
      source: string | null;
      r2_key: string | null;
      mime: string | null;
      extracted_text: string | null;
      chunks: number | null;
    }[])[0];
    if (!r) return c.json({ error: "not found" }, 404);
    const prevChunks = Number(r.chunks ?? 0);

    let extractedText: string | null = r.extracted_text;
    let summary: string | null = null;
    let chunks = 0;
    let indexStatus: MaterialIndexStatus = "processing";
    let error: string | null = null;

    try {
      if (r.type === "file") {
        if (!r.r2_key) throw new Error("R2 원본 없음");
        if (isTextExtractable(r.mime || "", r.name || "")) {
          const obj = await c.env.R2.get(r.r2_key);
          if (!obj) throw new Error("R2 오브젝트 없음");
          const decoded = new TextDecoder().decode(await obj.arrayBuffer());
          const isHtml = /html/.test(r.mime || "") || /\.html?$/i.test(r.name || "");
          const ext = buildMaterialExtraction(isHtml ? htmlToParagraphs(decoded) : decoded);
          extractedText = ext.extractedText;
          summary = ext.summary;
          chunks = ext.chunks;
          indexStatus = "indexed";
        } else {
          // pdf·docx·이미지 등 — R2 원본을 Workers AI toMarkdown 으로 재추출.
          const obj = await c.env.R2.get(r.r2_key);
          if (!obj) throw new Error("R2 오브젝트 없음");
          const md = await extractViaToMarkdown(c.env, r.name || "file", await obj.arrayBuffer(), r.mime || "");
          const ext = buildMaterialExtraction(md);
          extractedText = ext.extractedText;
          summary = ext.summary;
          chunks = ext.chunks;
          indexStatus = "indexed";
        }
      } else if (r.type === "url") {
        const url = String(r.source ?? "");
        if (!/^https?:\/\//i.test(url)) throw new Error("유효한 URL 없음");
        const res = await fetch(url, {
          headers: { "User-Agent": "malgn-helper-material/1.0" },
          redirect: "follow",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ext = buildMaterialExtraction(htmlToParagraphs(await res.text()));
        extractedText = ext.extractedText;
        summary = ext.summary;
        chunks = ext.chunks;
        indexStatus = "indexed";
      } else {
        // text/qa — 저장된 extracted_text 로 요약·청크 재계산.
        const base = String(r.extracted_text ?? "");
        if (!base) throw new Error("재색인할 본문 없음");
        const ext = buildMaterialExtraction(base);
        extractedText = ext.extractedText;
        summary = ext.summary;
        chunks = ext.chunks;
        indexStatus = "indexed";
      }
    } catch (e) {
      indexStatus = "failed";
      error = `재색인 실패: ${(e as Error).message}`.slice(0, 500);
    }

    // 벡터 색인 갱신: indexed → 이전 벡터 정리 후 재색인. 그 외 → 기존 벡터 제거.
    if (indexStatus === "indexed" && extractedText) {
      const rv = await indexMaterialVectors(c.env, id, r.name || "", extractedText, prevChunks);
      chunks = rv.chunks;
      if (rv.vectorError) error = error ? `${error}; ${rv.vectorError}`.slice(0, 500) : rv.vectorError;
    } else {
      await deleteMaterialVectors(c.env, id, prevChunks);
    }

    await conn.query(
      `UPDATE hp_material
          SET index_status = ?, summary = ?, extracted_text = ?, chunks = ?, error = ?, updated_at = NOW()
        WHERE id = ? AND status = 1`,
      [indexStatus, summary, extractedText, chunks, error, id],
    );
    return c.json({ ok: true, id, indexStatus, summary, chunks, error });
  }),
);

// DELETE /materials/:id — soft delete(status=-1) + R2 원본 삭제(있으면).
app.delete("/materials/:id", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    if (!(await materialTableExists(conn))) return c.json(MATERIAL_TABLE_MISSING, 503);
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const [rows] = await conn.query(`SELECT r2_key, chunks FROM hp_material WHERE id = ? AND status = 1`, [id]);
    const r = (rows as { r2_key: string | null; chunks: number | null }[])[0];
    if (!r) return c.json({ error: "not found" }, 404);
    const [res] = await conn.query(`UPDATE hp_material SET status = -1 WHERE id = ? AND status = 1`, [id]);
    if ((res as unknown as { affectedRows: number }).affectedRows === 0) return c.json({ error: "not found" }, 404);
    // 자료 벡터 제거(m{id}-0..chunks-1). Vectorize 미가용/실패는 무시.
    await deleteMaterialVectors(c.env, id, Number(r.chunks ?? 0));
    if (r.r2_key) {
      try {
        await c.env.R2.delete(r.r2_key);
      } catch {
        /* R2 삭제 실패는 무시 — 메타(status=-1)는 이미 반영. 고아 오브젝트는 별도 정리. */
      }
    }
    return c.json({ ok: true, id });
  }),
);

// GET /materials/search — 의미검색(RAG). q 임베딩(bge-m3) → Vectorize query → materialId 그룹핑.
//   응답: { results: [{ materialId, name, type, score, snippets: string[] }] }
//   Vectorize/AI 미가용 시 { results: [], vectorizeUnavailable: true }(+error).
//   ⚠ 정적 경로 /search 는 동적 /:id 보다 라우터 우선(RegExpRouter). 안전하게 :id 앞에 등록.
app.get("/materials/search", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    if (!(await materialTableExists(conn))) return c.json(MATERIAL_TABLE_MISSING, 503);
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "q(검색어)가 필요합니다." }, 400);
    const topK = Math.min(Math.max(parseInt(c.req.query("topK") ?? "10", 10) || 10, 1), 50);

    if (!vectorizeAvailable(c.env)) return c.json({ results: [], vectorizeUnavailable: true });

    // 1) 질의 임베딩
    let queryVec: number[];
    try {
      const out = (await c.env.AI.run(MATERIAL_EMBED_MODEL, { text: [q] })) as unknown as {
        data?: number[][];
      };
      const v = out?.data?.[0];
      if (!Array.isArray(v) || v.length === 0) throw new Error("임베딩 결과 없음");
      queryVec = v;
    } catch (e) {
      return c.json({
        results: [],
        vectorizeUnavailable: true,
        error: `질의 임베딩 실패: ${(e as Error).message}`.slice(0, 300),
      });
    }

    // 2) Vectorize 검색
    let matches: VectorizeMatch[];
    try {
      const res = await c.env.VECTORIZE.query(queryVec, { topK, returnMetadata: "all" });
      matches = res.matches ?? [];
    } catch (e) {
      return c.json({
        results: [],
        vectorizeUnavailable: true,
        error: `의미검색 실패: ${(e as Error).message}`.slice(0, 300),
      });
    }

    // 3) materialId 그룹핑(최고 score + 상위 스니펫)
    const grouped = new Map<number, { score: number; snippets: string[] }>();
    for (const m of matches) {
      const md = (m.metadata ?? {}) as { materialId?: number | string; snippet?: unknown };
      const mid = Number(md.materialId);
      if (!Number.isFinite(mid) || mid <= 0) continue;
      const g = grouped.get(mid) ?? { score: 0, snippets: [] };
      if (typeof m.score === "number" && m.score > g.score) g.score = m.score;
      if (typeof md.snippet === "string" && md.snippet && g.snippets.length < 3) {
        g.snippets.push(md.snippet);
      }
      grouped.set(mid, g);
    }
    if (grouped.size === 0) return c.json({ results: [] });

    // 4) hp_material 조회(status=1 만) → 최종 결과(score desc)
    const ids = [...grouped.keys()];
    const placeholders = ids.map(() => "?").join(",");
    const [rows] = await conn.query(
      `SELECT id, name, type FROM hp_material WHERE status = 1 AND id IN (${placeholders})`,
      ids,
    );
    const byId = new Map<number, { name: string; type: string }>();
    for (const row of rows as { id: number; name: string; type: string }[]) {
      byId.set(Number(row.id), { name: row.name, type: row.type });
    }
    const results = ids
      .map((mid) => {
        const info = byId.get(mid);
        const g = grouped.get(mid);
        if (!info || !g) return null;
        return { materialId: mid, name: info.name, type: info.type, score: g.score, snippets: g.snippets };
      })
      .filter((x): x is { materialId: number; name: string; type: string; score: number; snippets: string[] } => x !== null)
      .sort((a, b) => b.score - a.score);
    return c.json({ results });
  }),
);

// GET /materials/:id — 상세. extracted_text 프리뷰(앞 20k) + file 이면 downloadPath.
//   ⚠ /:id/download·/:id/reindex 는 세그먼트 수가 달라 라우팅 충돌 없음(등록 순서 무관).
app.get("/materials/:id", requireAuth, requireRole(ROLE_LEVEL.developer), async (c) =>
  withConn(c, async (conn) => {
    if (!(await materialTableExists(conn))) return c.json(MATERIAL_TABLE_MISSING, 503);
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const [rows] = await conn.query(
      `SELECT id, name, type, source, format, r2_key, mime, size_bytes, index_status,
              summary, extracted_text, chunks, tags, services, error, created_by, created_at, updated_at
         FROM hp_material WHERE id = ? AND status = 1`,
      [id],
    );
    const r = (rows as MaterialRow[])[0];
    if (!r) return c.json({ error: "not found" }, 404);
    const fullText = typeof r.extracted_text === "string" ? r.extracted_text : "";
    return c.json({
      ...toMaterialListDto(r),
      error: r.error ?? null,
      updatedAt: r.updated_at,
      hasFile: r.type === "file" && !!r.r2_key,
      extractedTextPreview: fullText.slice(0, MATERIAL_PREVIEW_LEN),
      extractedTextLength: fullText.length,
      extractedTextTruncated: fullText.length > MATERIAL_PREVIEW_LEN,
    });
  }),
);

// ── 고객 챗봇 답변 파이프라인 (POST /chat/answer) — public + rateLimitLlm ──
// 원칙(CLAUDE.md): 정확성·일관성 · 표준답변 우선 · 근거+출처 인용 · "모르면 모른다"(추측 금지→상담사 에스컬레이션).
// 흐름: ① approved 표준답변 강매칭 → standard(본문 그대로)  ② RAG(Vectorize 자료 청크 임계 이상) → rag(LLM, 근거만 사용)  ③ 그 외 → escalate.
// 모든 외부 의존(Vectorize/AI/LLM)은 graceful — 실패 시 db_only(표준답변)·escalate 폴백, 절대 500 안 냄.
const CHAT_STD_THRESHOLD = 0.5; // (폴백 전용) 표준답변 어휘 자카드 임계 — VECTORIZE_SA 미가용 시에만 사용.
// 표준답변 임베딩(cosine) 강매칭 임계 — top1 ≥ 이면 해당 SA 본문 그대로 standard 모드 반환.
// 봇 unknown_policy(strict/lenient)로 ±0.05 가감, 0.5~0.9 클램프(saMatchThresholdFor).
const SA_MATCH_THRESHOLD = 0.62;
// 강매칭 미만이지만 이 이상이면 그 SA 를 RAG 컨텍스트의 참고 근거로 넘김.
const SA_MATCH_CONTEXT_MIN = 0.55;
const SA_MATCH_TOPK = 5; // VECTORIZE_SA query top-K.
const CHAT_RAG_THRESHOLD = 0.5; // 자료 청크 cosine 임계(top ≥ → RAG 답변). 봇 escalation_threshold 있으면 대체.
const CHAT_STD_FALLBACK = 0.35; // RAG 불가(Vectorize/AI 다운) 시 db_only 폴백 허용 표준답변 최소 점수.
const CHAT_QUESTION_MAX = 2000; // 질문 길이 상한.
const CHAT_RAG_TOPK = 6; // Vectorize top-K(자료 청크).
const CHAT_ESCALATE_DEFAULT =
  "문의하신 내용은 정확한 확인이 필요해 상담사에게 연결해 드리겠습니다. 잠시만 기다려 주세요.";

type ChatSourceKind = "standard_answer" | "material";
type ChatSource = {
  kind: ChatSourceKind;
  id: number;
  title: string;
  snippet?: string;
  score?: number;
};
type ChatMode = "standard" | "rag" | "escalate";
// 표준답변 매칭 후보(임베딩 매칭 결과 또는 자카드 폴백 결과를 통일 표현).
type SaCandidate = { id: number; label: string; score: number };
type ChatAnswerResponse = {
  answer: string;
  mode: ChatMode;
  confidence: number; // 0~1
  sources: ChatSource[];
  usedChunks?: number;
};
type ChatAnswerBody = {
  question?: unknown;
  serviceId?: unknown;
  botId?: unknown;
  topicId?: unknown;
};
// botId 주면 hp_bot에서 로드하는 정책(서비스범위·페르소나·모름정책·에스컬레이션 임계).
type ChatBotPolicy = {
  serviceId: number | null;
  name: string | null;
  systemPrompt: string | null; // 페르소나
  unknownPolicy: BotUnknownPolicy; // strict/normal/lenient → RAG 임계 가감
  useStandardAnswers: boolean;
  standardAnswerScope: BotStandardAnswerScope; // all | service
  escalationThreshold: number; // hp_bot.escalation_threshold (0~1). 유효값이면 RAG 임계로 사용.
};

function toIntOrNull(v: unknown): number | null | "invalid" {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return "invalid";
  return n;
}

// RAG 자료 검색(내부 헬퍼) — /materials/search 와 동일 로직: q 임베딩(bge-m3) → Vectorize query → materialId 그룹핑.
// 실패·미가용 시 { available:false } 로 graceful degrade(호출부가 escalate/db_only 로 폴백).
async function chatRagSearchMaterials(
  conn: Queryable,
  env: Bindings,
  q: string,
  topK: number,
): Promise<{
  available: boolean;
  results: Array<{ materialId: number; name: string; score: number; snippets: string[] }>;
}> {
  if (!vectorizeAvailable(env)) return { available: false, results: [] };
  if (!(await materialTableExists(conn))) return { available: false, results: [] };
  // 1) 질의 임베딩
  let queryVec: number[];
  try {
    const out = (await env.AI.run(MATERIAL_EMBED_MODEL, { text: [q] })) as unknown as { data?: number[][] };
    const v = out?.data?.[0];
    if (!Array.isArray(v) || v.length === 0) throw new Error("임베딩 결과 없음");
    queryVec = v;
  } catch {
    return { available: false, results: [] };
  }
  // 2) Vectorize 검색
  let matches: VectorizeMatch[];
  try {
    const res = await env.VECTORIZE.query(queryVec, { topK, returnMetadata: "all" });
    matches = res.matches ?? [];
  } catch {
    return { available: false, results: [] };
  }
  // 3) materialId 그룹핑(최고 score + 상위 스니펫)
  const grouped = new Map<number, { score: number; snippets: string[] }>();
  for (const m of matches) {
    const md = (m.metadata ?? {}) as { materialId?: number | string; snippet?: unknown };
    const mid = Number(md.materialId);
    if (!Number.isFinite(mid) || mid <= 0) continue;
    const g = grouped.get(mid) ?? { score: 0, snippets: [] };
    if (typeof m.score === "number" && m.score > g.score) g.score = m.score;
    if (typeof md.snippet === "string" && md.snippet && g.snippets.length < 3) g.snippets.push(md.snippet);
    grouped.set(mid, g);
  }
  if (grouped.size === 0) return { available: true, results: [] };
  // 4) hp_material 조회(status=1)로 정본 name 확보
  const ids = [...grouped.keys()];
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await conn.query(
    `SELECT id, name FROM hp_material WHERE status = 1 AND id IN (${placeholders})`,
    ids,
  );
  const byId = new Map<number, string>();
  for (const row of rows as { id: number; name: string }[]) byId.set(Number(row.id), row.name);
  const results = ids
    .map((mid) => {
      const name = byId.get(mid);
      const g = grouped.get(mid);
      if (name == null || !g) return null;
      return { materialId: mid, name, score: g.score, snippets: g.snippets };
    })
    .filter((x): x is { materialId: number; name: string; score: number; snippets: string[] } => x !== null)
    .sort((a, b) => b.score - a.score);
  return { available: true, results };
}

// unknown_policy → RAG 임계 가감(strict=엄격/더 자주 에스컬레이션, lenient=완화).
function ragThresholdFor(policy: ChatBotPolicy | null): number {
  let base = CHAT_RAG_THRESHOLD;
  if (policy && policy.escalationThreshold > 0 && policy.escalationThreshold < 1) {
    base = policy.escalationThreshold; // 봇 설정값 우선.
  }
  if (policy?.unknownPolicy === "strict") base += 0.1;
  else if (policy?.unknownPolicy === "lenient") base -= 0.1;
  return Math.min(0.95, Math.max(0.2, base));
}

// unknown_policy → SA 임베딩 강매칭 임계 가감(strict=+0.05 더 엄격, lenient=-0.05 완화). 0.5~0.9 클램프.
function saMatchThresholdFor(policy: ChatBotPolicy | null): number {
  let base = SA_MATCH_THRESHOLD;
  if (policy?.unknownPolicy === "strict") base += 0.05;
  else if (policy?.unknownPolicy === "lenient") base -= 0.05;
  return Math.min(0.9, Math.max(0.5, base));
}

// 표준답변 임베딩 매칭(내부 헬퍼) — 질의 임베딩(bge-m3) → VECTORIZE_SA.query(topK, returnMetadata:"all").
//   scope='service' + serviceId 지정 시: metadata.scope='common' 또는 metadata.serviceId 일치만 채택(봇 서비스 범위).
//   실패·미가용 시 { available:false } → 호출부가 자카드 폴백.
async function chatQueryStandardAnswerVectors(
  env: Bindings,
  q: string,
  opts: { scope: "all" | "service"; serviceId: number | null },
): Promise<{
  available: boolean;
  matches: Array<{ saId: number; label: string; scope: SaScope; serviceId: number; topicId: number; score: number }>;
}> {
  if (!vectorizeSaAvailable(env)) return { available: false, matches: [] };
  let queryVec: number[];
  try {
    const out = (await env.AI.run(SA_EMBED_MODEL, { text: [q] })) as unknown as { data?: number[][] };
    const v = out?.data?.[0];
    if (!Array.isArray(v) || v.length === 0) throw new Error("임베딩 결과 없음");
    queryVec = v;
  } catch {
    return { available: false, matches: [] };
  }
  let raw: VectorizeMatch[];
  try {
    const res = await env.VECTORIZE_SA.query(queryVec, { topK: SA_MATCH_TOPK, returnMetadata: "all" });
    raw = res.matches ?? [];
  } catch {
    return { available: false, matches: [] };
  }
  const matches = raw
    .map((m) => {
      const md = (m.metadata ?? {}) as {
        saId?: number | string; scope?: string; serviceId?: number | string; topicId?: number | string; label?: unknown;
      };
      const saId = Number(md.saId);
      if (!Number.isFinite(saId) || saId <= 0) return null;
      const scope: SaScope = md.scope === "common" ? "common" : "service";
      return {
        saId,
        label: typeof md.label === "string" ? md.label : "",
        scope,
        serviceId: Number(md.serviceId) || 0,
        topicId: Number(md.topicId) || 0,
        score: typeof m.score === "number" ? m.score : 0,
      };
    })
    .filter((x): x is { saId: number; label: string; scope: SaScope; serviceId: number; topicId: number; score: number } => x !== null)
    // 봇 service 범위: common 또는 해당 서비스만.
    .filter((x) => !(opts.scope === "service" && opts.serviceId != null) || x.scope === "common" || x.serviceId === opts.serviceId)
    .sort((a, b) => b.score - a.score);
  return { available: true, matches };
}

app.post("/chat/answer", rateLimitLlm, async (c) =>
  withConn(c, async (conn) => {
    // ── 입력 검증(public → 신뢰 불가 데이터 가정) ──
    const body = await c.req.json<ChatAnswerBody>().catch((): ChatAnswerBody => ({}));
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return c.json({ error: "question required" }, 400);
    if (question.length > CHAT_QUESTION_MAX) {
      return c.json({ error: `question too long (<=${CHAT_QUESTION_MAX})` }, 400);
    }
    const sidIn = toIntOrNull(body.serviceId);
    if (sidIn === "invalid") return c.json({ error: "invalid serviceId" }, 400);
    const botIn = toIntOrNull(body.botId);
    if (botIn === "invalid") return c.json({ error: "invalid botId" }, 400);
    const topicIn = toIntOrNull(body.topicId);
    if (topicIn === "invalid") return c.json({ error: "invalid topicId" }, 400);

    // ── 봇 정책 로드(botId 있을 때만; 실패는 graceful) ──
    let policy: ChatBotPolicy | null = null;
    if (botIn != null) {
      try {
        const [brows] = await conn.query(
          `SELECT service_id, name, system_prompt, unknown_policy, escalation_threshold,
                  use_standard_answers, standard_answer_scope
             FROM hp_bot WHERE id = ? AND status = 1`,
          [botIn],
        );
        const b = (brows as Array<{
          service_id: number | null;
          name: string | null;
          system_prompt: string | null;
          unknown_policy: BotUnknownPolicy;
          escalation_threshold: string | number;
          use_standard_answers: number;
          standard_answer_scope: BotStandardAnswerScope;
        }>)[0];
        if (b) {
          policy = {
            serviceId: b.service_id,
            name: b.name,
            systemPrompt: b.system_prompt,
            unknownPolicy: b.unknown_policy,
            useStandardAnswers: b.use_standard_answers === 1,
            standardAnswerScope: b.standard_answer_scope,
            escalationThreshold: Number(b.escalation_threshold),
          };
        }
      } catch {
        policy = null; // 봇 로드 실패해도 파이프라인은 진행.
      }
    }
    // 유효 서비스 범위: 입력 serviceId 우선, 없으면 봇의 service_id.
    const effectiveServiceId: number | null = sidIn != null ? sidIn : policy?.serviceId ?? null;
    const ragThreshold = ragThresholdFor(policy);

    // approved 표준답변 본문 조회(라이브 재확인 — 조회 시점 approved·status=1). PII 텍스트 차단분 제외.
    async function loadApprovedAnswer(id: number): Promise<string | null> {
      try {
        const [rows] = await conn.query(
          `SELECT answer FROM hp_standard_answer
             WHERE id = ? AND status = 1 AND approval_status = 'approved' AND pii_text_status <> 'blocked'`,
          [id],
        );
        const r = (rows as Array<{ answer: string | null }>)[0];
        const ans = (r?.answer ?? "").trim();
        return ans || null;
      } catch {
        return null;
      }
    }

    const useSa = policy?.useStandardAnswers !== false; // 봇이 명시적으로 끈 경우만 제외.
    // RAG 컨텍스트 참고용(중간점수) SA + RAG 불가 시 db_only 폴백 후보. 둘 다 없으면 escalate.
    let ragRefSa: SaCandidate | null = null;
    let fallbackSa: SaCandidate | null = null;

    // ── ① 표준답변 우선 — 임베딩(VECTORIZE_SA) 강매칭 → standard 모드(본문 그대로, LLM 미경유) ──
    if (useSa) {
      const saScopeMode: "all" | "service" = policy?.standardAnswerScope === "service" ? "service" : "all";
      const saVec = await chatQueryStandardAnswerVectors(c.env, question, {
        scope: saScopeMode,
        serviceId: effectiveServiceId,
      });

      if (saVec.available) {
        const saThreshold = saMatchThresholdFor(policy);
        const top1 = saVec.matches[0] ?? null;
        if (top1) {
          if (top1.score >= saThreshold) {
            // 강매칭 — 라이브 approved 본문 재확인 후 그대로 반환.
            const answer = await loadApprovedAnswer(top1.saId);
            if (answer) {
              const resp: ChatAnswerResponse = {
                answer,
                mode: "standard",
                confidence: Math.min(1, Number(top1.score.toFixed(3))),
                sources: [{ kind: "standard_answer", id: top1.saId, title: top1.label, score: Number(top1.score.toFixed(3)) }],
              };
              return c.json(resp);
            }
            // 본문 유실(approved 이탈/차단) → 참고 근거로만 활용하고 RAG 진행.
            ragRefSa = { id: top1.saId, label: top1.label, score: top1.score };
          } else if (top1.score >= SA_MATCH_CONTEXT_MIN) {
            // 준매칭 — RAG 컨텍스트 참고 근거로 첨부.
            ragRefSa = { id: top1.saId, label: top1.label, score: top1.score };
          }
          // db_only 폴백 후보(임베딩 점수 그대로).
          if (top1.score >= SA_MATCH_CONTEXT_MIN) fallbackSa = { id: top1.saId, label: top1.label, score: top1.score };
        }
        // 하이브리드 — 임베딩 강매칭 실패 시 어휘(자카드) 신호로 보강(동의어·표현차 대비).
        try {
          let jac = await findSimilarStandardAnswers(conn, { question, topicId: topicIn, serviceId: effectiveServiceId, limit: 5 });
          jac = jac.filter((s) => s.approvalStatus === "approved");
          if (policy?.standardAnswerScope === "service" && effectiveServiceId != null) {
            jac = jac.filter((s) => s.scope === "common" || s.serviceId === effectiveServiceId);
          }
          const jtop = jac[0] ?? null;
          if (jtop && jtop.score >= CHAT_STD_THRESHOLD) {
            const answer = await loadApprovedAnswer(jtop.id);
            if (answer) {
              const resp: ChatAnswerResponse = {
                answer,
                mode: "standard",
                confidence: Math.min(1, jtop.score),
                sources: [{ kind: "standard_answer", id: jtop.id, title: jtop.label, score: jtop.score }],
              };
              return c.json(resp);
            }
          }
          if (jtop && !fallbackSa) fallbackSa = { id: jtop.id, label: jtop.label, score: jtop.score };
        } catch { /* 자카드 보강 실패는 무시 */ }
      } else {
        // ── 폴백: VECTORIZE_SA 미가용 → 기존 findSimilarStandardAnswers(자카드) ──
        let similar: SaSimilar[] = [];
        try {
          similar = await findSimilarStandardAnswers(conn, {
            question,
            topicId: topicIn,
            serviceId: effectiveServiceId,
            limit: 5,
          });
        } catch {
          similar = [];
        }
        let approved = similar.filter((s) => s.approvalStatus === "approved");
        if (policy?.standardAnswerScope === "service" && effectiveServiceId != null) {
          approved = approved.filter((s) => s.scope === "common" || s.serviceId === effectiveServiceId);
        }
        const topSa = approved[0] ?? null;
        if (topSa) {
          if (topSa.score >= CHAT_STD_THRESHOLD) {
            const answer = await loadApprovedAnswer(topSa.id);
            if (answer) {
              const resp: ChatAnswerResponse = {
                answer,
                mode: "standard",
                confidence: Math.min(1, topSa.score),
                sources: [{ kind: "standard_answer", id: topSa.id, title: topSa.label, score: topSa.score }],
              };
              return c.json(resp);
            }
          }
          // 중간점수 → RAG 참고 근거. 어느 경우든 db_only 폴백 후보로 보존.
          if (topSa.score < CHAT_STD_THRESHOLD) ragRefSa = { id: topSa.id, label: topSa.label, score: topSa.score };
          fallbackSa = { id: topSa.id, label: topSa.label, score: topSa.score };
        }
      }
    }

    // ── ② RAG(Vectorize 자료 청크) ──
    const rag = await chatRagSearchMaterials(conn, c.env, question, CHAT_RAG_TOPK);
    if (rag.available) {
      const qualifying = rag.results.filter((r) => r.score >= ragThreshold);
      if (qualifying.length > 0) {
        // 컨텍스트: 상위 자료 청크(snippet). 준매칭 approved 표준답변 있으면 참고로 첨부.
        const contextParts: string[] = qualifying.map((r, i) => {
          const snips = r.snippets.length ? r.snippets.join(" … ") : "(발췌 없음)";
          return `[자료 ${i + 1}] 자료명: ${r.name}\n${snips}`;
        });
        let midSaAnswer: string | null = null;
        if (ragRefSa) midSaAnswer = await loadApprovedAnswer(ragRefSa.id);
        const persona = policy?.systemPrompt?.trim();
        const system =
          "너는 고객 상담 챗봇이다. 아래 규칙을 반드시 지켜라.\n" +
          "1) 제공된 '근거 자료'에 있는 내용만 사용해 정확히 답한다.\n" +
          "2) 근거에 없는 내용은 추측하거나 지어내지 말고, answer 대신 insufficient=true 로 표시한다.\n" +
          "3) 답변의 각 핵심 사실 끝에 [출처: 자료명] 형태로 근거를 인용한다.\n" +
          "4) 한국어로 정중하고 간결하게 답한다.\n" +
          (persona ? `봇 페르소나: ${persona}\n` : "") +
          '반드시 JSON 으로만 응답: {"answer": string, "insufficient": boolean}';
        const user =
          `고객 질문: ${question}\n\n근거 자료:\n${contextParts.join("\n\n")}` +
          (midSaAnswer ? `\n\n(참고용 승인 표준답변 — 근거로 인용 가능):\n${midSaAnswer.slice(0, 1500)}` : "");

        try {
          const llm = await callOpenAiJson<{ answer?: string; insufficient?: boolean }>(c.env, {
            system,
            user,
            maxTokens: 700,
            temperature: 0.2,
          });
          const genAnswer = (llm.data.answer ?? "").trim();
          const insufficient = llm.data.insufficient === true;
          if (!insufficient && genAnswer) {
            const topScore = qualifying[0].score;
            const sources: ChatSource[] = qualifying.map((r) => ({
              kind: "material",
              id: r.materialId,
              title: r.name,
              snippet: r.snippets[0],
              score: Number(r.score.toFixed(3)),
            }));
            const resp: ChatAnswerResponse = {
              answer: genAnswer,
              mode: "rag",
              confidence: Math.min(1, Number(topScore.toFixed(3))),
              sources,
              usedChunks: qualifying.reduce((n, r) => n + r.snippets.length, 0),
            };
            return c.json(resp);
          }
          // insufficient → escalate 로 낙하.
        } catch {
          // LLM 실패 → escalate 로 낙하(graceful, 500 금지).
        }
      }
    } else {
      // ── RAG 불가(Vectorize/AI 다운) → db_only 폴백: 약하지만 approved 표준답변 있으면 사용 ──
      if (fallbackSa && fallbackSa.score >= CHAT_STD_FALLBACK) {
        const answer = await loadApprovedAnswer(fallbackSa.id);
        if (answer) {
          const resp: ChatAnswerResponse = {
            answer,
            mode: "standard",
            confidence: Math.min(1, fallbackSa.score),
            sources: [{ kind: "standard_answer", id: fallbackSa.id, title: fallbackSa.label, score: fallbackSa.score }],
          };
          return c.json(resp);
        }
      }
    }

    // ── ③ 모르면 모른다 → escalate(추측 금지) ──
    const bestScore = Math.max(fallbackSa?.score ?? 0, ragRefSa?.score ?? 0, rag.results[0]?.score ?? 0);
    const resp: ChatAnswerResponse = {
      answer: CHAT_ESCALATE_DEFAULT,
      mode: "escalate",
      confidence: Math.min(1, Number(bestScore.toFixed(3))),
      sources: [],
      usedChunks: 0,
    };
    return c.json(resp);
  }),
);

export default app;
