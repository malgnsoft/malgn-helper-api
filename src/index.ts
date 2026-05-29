import { Hono } from "hono";
import { cors } from "hono/cors";
import { createConnection } from "mysql2/promise";
import { openapiSpec, docHtml } from "./openapi";
import { callOpenAiJson } from "./llm";

type Bindings = {
  R2: R2Bucket;
  HYPERDRIVE: Hyperdrive;
  AI_GATEWAY_URL: string;
  AI_GATEWAY_TOKEN?: string;
  OPENAI_API_KEY: string;
  LLM_MODEL_DEFAULT: string;
  LLM_MODEL_PREMIUM: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (/\.pages\.dev$/.test(origin)) return origin;
      if (/\.malgnsoft\.com$/.test(origin)) return origin;
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      return null;
    },
    allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  }),
);

app.get("/", (c) => c.json({ name: "malgn-helper-api", status: "ok" }));
app.get("/healthz", (c) => c.json({ ok: true }));


// ── API 문서 (Scalar UI + OpenAPI 3.1 JSON) ─────────────
app.get("/doc", (c) => c.html(docHtml));
app.get("/doc/openapi.json", (c) => c.json(openapiSpec));

const WBS_KEY = "wbs/wbs.json";

app.get("/wbs", async (c) => {
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
  });
  try {
    return await fn(conn);
  } catch (e) {
    return c.json({ error: (e as Error).message, stack: (e as Error).stack?.split("\n").slice(0, 5) }, 500);
  } finally {
    c.executionCtx.waitUntil(conn.end());
  }
}

app.get("/db/ping", async (c) =>
  withConn(c, async (conn) => {
    const [rows] = await conn.query(
      "SELECT 1 AS ok, NOW() AS now, VERSION() AS version",
    );
    return c.json({ ok: true, rows });
  }),
);

// ── 임시 DB 탐색 엔드포인트 (스키마 파악 후 삭제) ────────
app.get("/db/whoami", async (c) =>
  withConn(c, async (conn) => {
    const [rows] = await conn.query(
      "SELECT DATABASE() AS db, CURRENT_USER() AS user, @@hostname AS host, VERSION() AS version",
    );
    return c.json({ rows });
  }),
);

app.get("/db/tables", async (c) =>
  withConn(c, async (conn) => {
    const [rows] = await conn.query("SHOW TABLES");
    return c.json({ count: (rows as any[]).length, rows });
  }),
);

app.get("/db/columns/:table", async (c) =>
  withConn(c, async (conn) => {
    const table = c.req.param("table");
    if (!/^[a-zA-Z0-9_]+$/.test(table)) return c.json({ error: "invalid table" }, 400);
    const [rows] = await conn.query(`DESCRIBE \`${table}\``);
    return c.json({ table, rows });
  }),
);

app.get("/db/sample/:table", async (c) =>
  withConn(c, async (conn) => {
    const table = c.req.param("table");
    if (!/^[a-zA-Z0-9_]+$/.test(table)) return c.json({ error: "invalid table" }, 400);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "5", 10), 20);
    const [rows] = await conn.query(`SELECT * FROM \`${table}\` LIMIT ${limit}`);
    return c.json({ table, limit, rows });
  }),
);

// ── PMS 연동 ─────────────────────────────────────────────
// reg_date가 'YYYYMMDDHHMMSS' varchar(14)이므로 ISO 형태로 변환
function toIso(s: string | null): string | null {
  if (!s || s.length !== 14) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}

// 프로젝트 목록 + 간이 통계 (검색·페이지네이션).
app.get("/pms/projects", async (c) =>
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
      `SELECT p.id, p.name, p.buyer, p.status, p.reg_date,
              (SELECT COUNT(*) FROM tb_post WHERE project_id = p.id AND status = 1) AS post_count,
              (SELECT MAX(reg_date) FROM tb_post WHERE project_id = p.id AND status = 1) AS last_activity
         FROM tb_project p
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

async function buildBriefingDbOnly(conn: any, id: number): Promise<any | null> {
    const [projRows] = await conn.query(
      `SELECT id, name, description, buyer, start_date, end_date, status
         FROM tb_project WHERE id = ?`,
      [id],
    );
    const proj = (projRows as any[])[0];
    if (!proj) return null;

    // 멤버: tb_project_user JOIN tb_user (활성 + status=1)
    const [memberRows] = await conn.query(
      `SELECT u.id, u.name, u.email, u.company, u.rank, pu.user_level,
              (u.email LIKE '%@malgnsoft.com') AS is_staff
         FROM tb_project_user pu
         JOIN tb_user u ON u.id = pu.user_id
        WHERE pu.project_id = ? AND pu.status = 1 AND u.status = 1`,
      [id],
    );

    // post 통계: 총수 / 첫/마지막 활동
    const [statsRows] = await conn.query(
      `SELECT COUNT(*) AS total,
              MIN(reg_date) AS first_post,
              MAX(reg_date) AS last_post
         FROM tb_post WHERE project_id = ? AND status = 1`,
      [id],
    );
    const stats0 = (statsRows as any[])[0];

    // 라벨 분포 (상위 6)
    const [labelRows] = await conn.query(
      `SELECT label, COUNT(*) AS cnt
         FROM tb_post
        WHERE project_id = ? AND status = 1 AND label IS NOT NULL AND label != ''
     GROUP BY label
     ORDER BY cnt DESC
        LIMIT 6`,
      [id],
    );

    // 직원별 응대(댓글) 건수 — staff = email LIKE '%@malgnsoft.com'
    const [staffRows] = await conn.query(
      `SELECT u.name, u.rank, COUNT(c.id) AS cnt
         FROM tb_post_comment c
         JOIN tb_user u ON u.id = c.user_id
         JOIN tb_post p ON p.id = c.post_id
        WHERE p.project_id = ? AND c.status = 1
          AND u.email LIKE '%@malgnsoft.com'
     GROUP BY u.id, u.name, u.rank
     ORDER BY cnt DESC
        LIMIT 10`,
      [id],
    );

    // 미응답: 직원 댓글 없는 고객 글
    const [unansweredRows] = await conn.query(
      `SELECT COUNT(*) AS cnt
         FROM tb_post p
         JOIN tb_user pu ON pu.id = p.user_id
        WHERE p.project_id = ? AND p.status = 1
          AND pu.email NOT LIKE '%@malgnsoft.com'
          AND NOT EXISTS (
            SELECT 1 FROM tb_post_comment c
              JOIN tb_user cu ON cu.id = c.user_id
             WHERE c.post_id = p.id AND c.status = 1
               AND cu.email LIKE '%@malgnsoft.com'
          )`,
      [id],
    );
    const unanswered = (unansweredRows as any[])[0]?.cnt ?? 0;

    // 가장 오래된 미응답 1건(알림용)
    const [oldestUnansweredRows] = await conn.query(
      `SELECT p.id, p.subject, p.reg_date, p.writer
         FROM tb_post p
         JOIN tb_user pu ON pu.id = p.user_id
        WHERE p.project_id = ? AND p.status = 1
          AND pu.email NOT LIKE '%@malgnsoft.com'
          AND NOT EXISTS (
            SELECT 1 FROM tb_post_comment c
              JOIN tb_user cu ON cu.id = c.user_id
             WHERE c.post_id = p.id AND c.status = 1
               AND cu.email LIKE '%@malgnsoft.com'
          )
     ORDER BY p.reg_date ASC
        LIMIT 1`,
      [id],
    );
    const oldestUnanswered = (oldestUnansweredRows as any[])[0];

    // 평균 첫 응답 시간(FRT, 분 단위) — staff 댓글까지 걸린 시간 (서브쿼리: post별 first staff comment)
    const [frtRows] = await conn.query(
      `SELECT AVG(TIMESTAMPDIFF(MINUTE,
                STR_TO_DATE(sub.post_at, '%Y%m%d%H%i%s'),
                STR_TO_DATE(sub.first_at, '%Y%m%d%H%i%s'))) AS avg_minutes
         FROM (
           SELECT p.reg_date AS post_at, MIN(c.reg_date) AS first_at
             FROM tb_post p
             JOIN tb_post_comment c ON c.post_id = p.id
             JOIN tb_user cu ON cu.id = c.user_id
            WHERE p.project_id = ? AND p.status = 1 AND c.status = 1
              AND cu.email LIKE '%@malgnsoft.com'
         GROUP BY p.id, p.reg_date
         ) sub`,
      [id],
    );
    const avgMinutes = Number((frtRows as any[])[0]?.avg_minutes);
    const avgFRT = !Number.isFinite(avgMinutes)
      ? "—"
      : avgMinutes < 60
        ? `${Math.round(avgMinutes)}m`
        : `${Math.round(avgMinutes / 60)}h`;

    // ── Briefing 객체 조립 ──────────────────────────────
    const members = memberRows as any[];
    const customers = members.filter((m) => m.is_staff !== 1);
    const staffs = members.filter((m) => m.is_staff === 1);

    const primaryCustomer = customers[0] ?? null;
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

    const briefing = {
      meta: {
        projectId: proj.id,
        projectName: proj.name,
        active: proj.status === 1,
        statusLabel: unanswered > 0 ? "주의" : "원활",
        statusReason: unanswered > 0 ? `직원 응답 없음 ${unanswered}건` : "미응답 없음",
        subtitle: proj.description?.slice(0, 80) ?? proj.buyer ?? "",
        lifecycle: proj.status === 1 ? "유지보수 진행" : "종료",
        builtAt: monthOf(stats0.first_post) ?? "",
        lastActivity: monthOf(stats0.last_post) ?? "",
        generatedAt: new Date().toISOString().slice(0, 10),
        domainRule: "@malgnsoft.com → 직원 / 그 외 → 고객",
      },
      customer: {
        primary: primaryCustomer
          ? { name: primaryCustomer.name, email: primaryCustomer.email, role: primaryCustomer.rank || primaryCustomer.company }
          : { name: "(고객 멤버 없음)", email: "", role: "" },
        others: customers.slice(1, 6).map((m) => ({
          name: m.name,
          email: m.email,
          role: m.rank || m.company,
        })),
        note: customers.length > 6 ? `+ ${customers.length - 6}명` : undefined,
      },
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
        total: Number(stats0.total ?? 0),
        avgFRT,
        unanswered: Number(unanswered),
        urgent: 0, // TODO: 라벨 '긴급' 또는 키워드 룰
      },
      hotTopics: [], // LLM 영역 (제목 군집화)
      hotLabels: (labelRows as any[]).map((r) => ({
        name: r.label,
        count: Number(r.cnt),
      })),
      alerts,
      faq: [], // LLM 영역
      policies: [], // LLM 영역
    };

    return briefing;
}

// GET: 즉시 집계 (DB only) — 캐시 사용 안 함, 저장 안 함
app.get("/pms/projects/:id/briefing", async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const briefing = await buildBriefingDbOnly(conn, id);
    if (!briefing) return c.json({ error: "not found" }, 404);
    return c.json({ briefing });
  }),
);

// POST: 새 브리핑 카드 생성 — hp_briefing 저장 + LLM(hotTopics)
//   캐시: 동일 input_hash + 24h 이내면 LLM 미호출. ?force=1로 우회.
//   LLM 실패 시 graceful degrade — DB-only 브리핑은 그대로 저장.
app.post("/pms/projects/:id/briefing/generate", async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const force = c.req.query("force") === "1";
    const skipLlm = c.req.query("nollm") === "1";
    const t0 = Date.now();
    const route = `POST /pms/projects/${id}/briefing/generate`;

    const briefing = await buildBriefingDbOnly(conn, id);
    if (!briefing) return c.json({ error: "not found" }, 404);

    // 캐시 키: 안정적인 DB 집계만 (LLM 결과 제외)
    const hashInput = JSON.stringify({
      stats: briefing.stats,
      customerCount: briefing.customer.others.length + (briefing.customer.primary?.name ? 1 : 0),
      staffCount: briefing.staff.primary.length + briefing.staff.aux.length,
      labels: briefing.hotLabels,
      alertCount: briefing.alerts.length,
    });
    const inputHash = await sha256Hex(hashInput);

    if (!force) {
      const [cacheRows] = await conn.query(
        `SELECT id, briefing_json, generated_at FROM hp_briefing
          WHERE project_id = ? AND status = 1 AND llm_input_hash = ?
            AND generated_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
          ORDER BY generated_at DESC LIMIT 1`,
        [id, inputHash],
      );
      const cached = (cacheRows as any[])[0];
      if (cached) {
        await conn.query(
          `INSERT INTO hp_llm_log (route, entity_type, entity_id, model, latency_ms, cache_hit)
           VALUES (?, 'briefing', ?, 'cache', ?, 1)`,
          [route, cached.id, Date.now() - t0],
        );
        return c.json({
          briefing: JSON.parse(cached.briefing_json),
          cached: true,
          id: cached.id,
          generatedAt: cached.generated_at,
        });
      }
    }

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
      // 입력: 최근 제목 100개 (둘 다 사용)
      const [titleRows] = await conn.query(
        `SELECT subject FROM tb_post
          WHERE project_id = ? AND status = 1 AND subject IS NOT NULL AND subject != ''
       ORDER BY reg_date DESC LIMIT 100`,
        [id],
      );
      const titles = (titleRows as any[])
        .map((r) => String(r.subject ?? "").trim())
        .filter((t) => t.length > 0);

      // 입력: 최근 staff 댓글 본문 20건 (faq/policies 추출용, 비공개 제외)
      const [staffMsgRows] = await conn.query(
        `SELECT c.content
           FROM tb_post_comment c
           JOIN tb_post p ON p.id = c.post_id
           JOIN tb_user u ON u.id = c.user_id
          WHERE p.project_id = ? AND c.status = 1
            AND u.email LIKE '%@malgnsoft.com'
            AND c.private_yn != 'Y'
            AND c.content IS NOT NULL AND c.content != ''
       ORDER BY c.reg_date DESC LIMIT 20`,
        [id],
      );
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
          statusLabel: string;
          statusReason: string;
          urgentCount: number;
          faq: string[];
          policies: Array<{ title: string; detail: string; source: string }>;
        }>(c.env, {
          system: [
            "You analyze a Korean customer support project and produce a concise briefing.",
            "Inputs: project stats summary + recent inquiry titles + recent staff replies.",
            "Output strict JSON:",
            '{ "statusLabel":"<짧은 한국어 라벨, 예: 주의/원활/긴급, 4글자 이내>",',
            '  "statusReason":"<한 줄 사유, 30자 이내>",',
            '  "urgentCount":<제목 100개 중 긴급/장애/오류성 추정 건수, int>,',
            '  "faq":["<자주 묻는 질문 패턴 1>","<2>","<3>", ...]   // 3~6개, 각 30자 이내,',
            '  "policies":[{"title":"<짧은 정책명>","detail":"<2~3문장>","source":"<출처 요약, 예: 직원 응답 패턴>"}, ...]  // 0~3개, 직원 응답에서 일관되게 관찰되는 응답 규칙만',
            "}",
            "FAQ는 실제 제목들에서 반복 패턴이 보일 때만. POLICIES는 staff 응답에서 명확한 규칙이 보일 때만(없으면 빈 배열).",
          ].join("\n"),
          user: [
            `프로젝트 통계: ${JSON.stringify(summary)}`,
            "",
            "=== 최근 문의 제목 (최대 100건) ===",
            titles.slice(0, 100).map((t, i) => `${i + 1}. ${t}`).join("\n"),
            "",
            "=== 최근 직원 응답 본문 (최대 20건, 비공개 제외) ===",
            staffMessages.map((m, i) => `${i + 1}. ${m}`).join("\n"),
          ].join("\n"),
          maxTokens: 900,
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
          if (v.data.statusLabel) briefing.meta.statusLabel = v.data.statusLabel.slice(0, 10);
          if (v.data.statusReason) briefing.meta.statusReason = v.data.statusReason.slice(0, 60);
          if (typeof v.data.urgentCount === "number") briefing.stats.urgent = v.data.urgentCount;
          briefing.faq = (v.data.faq ?? []).filter((s) => typeof s === "string").slice(0, 6);
          briefing.policies = (v.data.policies ?? []).slice(0, 3).map((p) => ({
            title: String(p.title ?? "").slice(0, 50),
            detail: String(p.detail ?? "").slice(0, 300),
            source: String(p.source ?? "").slice(0, 80),
          }));
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
    });
  }),
);

// GET: 프로젝트의 저장된 브리핑 목록 (히스토리 selectbox용, 메타만)
app.get("/pms/projects/:id/briefings", async (c) =>
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
app.get("/pms/briefings/:id", async (c) =>
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
app.delete("/pms/briefings/:id", async (c) =>
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
  "  D 표준화 가능성 (재사용 가능한 답변인지) + templates 1~3개 제안",
  "  E 친절도·태도 (어조, 공감)",
  "",
  "JSON schema:",
  '{ "oneLiner":"<한 줄 평>",',
  '  "axes":[',
  '    {"letter":"A","title":"응답 속도","score":4,"scoreLabel":"양호","commentary":"...","bullets":[{"text":"...","emphasis":"high|normal"}]},',
  '    {"letter":"B",...},',
  '    {"letter":"C",...},',
  '    {"letter":"D","title":"표준화 가능성","score":3,"commentary":"...","templates":[{"label":"<짧은>","question":"<질문 패턴>","answer":"<답변 본문>"}]},',
  '    {"letter":"E",...}',
  '  ],',
  '  "overallVerdict":"<종합 평 한 줄>",',
  '  "followups":[{"title":"...","detail":"..."}],',
  '  "observation":{"title":"...","body":"...","hint":"..."} }',
  "",
  "Rules: bullets·templates·followups·observation는 의미 있을 때만 채우고 비어도 됨. templates는 D축에 1~3개. score가 정해지지 않으면 'warn' + scoreLabel='주의'.",
].join("\n");

app.post("/pms/posts/:id/eval/generate", async (c) =>
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
              (u.email LIKE '%@malgnsoft.com') AS u_is_staff
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
          AND u.email LIKE '%@malgnsoft.com'
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
      followups: [],
      observation: undefined,
    };
    let generator: "db_only" | "hybrid" = "db_only";
    let llmModel: string | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let llmLatency: number | null = null;
    let costUsd: number | null = null;
    let llmError: string | null = null;

    if (!skipLlm && c.env.OPENAI_API_KEY && resp) {
      try {
        const userMsg = [
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
          (post.content ?? "").slice(0, 5000),
          "",
          "=== 첫 직원 응답 ===",
          (resp.content ?? "").slice(0, 5000),
        ].join("\n");
        const llm = await callOpenAiJson<typeof llmResult>(c.env, {
          system: QA_SYSTEM_PROMPT,
          user: userMsg,
          maxTokens: 1500,
          temperature: 0.2,
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
      followups: llmResult.followups ?? [],
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

app.get("/pms/posts/:id/evals", async (c) =>
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

app.get("/pms/evals/:id", async (c) =>
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

app.delete("/pms/evals/:id", async (c) =>
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

app.post("/pms/projects/:id/standard-answer-suggestions", async (c) =>
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
          AND u.email LIKE '%@malgnsoft.com'
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
app.get("/admin/evals", async (c) =>
  withConn(c, async (conn) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const projectId = c.req.query("projectId");
    const minScore = c.req.query("minScore");
    const maxScore = c.req.query("maxScore");
    const hasScore = c.req.query("hasScore") === "1";
    const sort = c.req.query("sort") ?? "recent"; // recent | score_asc | score_desc | latency

    const where: string[] = ["e.status = 1"];
    const params: any[] = [];
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
              pj.name AS project_name
         FROM hp_qa_eval e
    LEFT JOIN tb_post p ON p.id = e.post_id
    LEFT JOIN tb_project pj ON pj.id = e.project_id
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
      })),
    });
  }),
);

// ── /admin/cost — LLM 호출 비용·지연·실패 대시보드 데이터 ───
app.get("/admin/cost", async (c) =>
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

// ── 표준 답변 카탈로그 (hp_standard_answer) ────────────
// QaEvalCard "표준답변으로 저장" 액션의 destination + 챗봇 응답 1순위 소스.

app.post("/standard-answers", async (c) =>
  withConn(c, async (conn) => {
    const body = await c.req.json<{
      label?: string;
      question?: string;
      answer?: string;
      projectId?: number | null;
      sourcePostId?: number | null;
      sourceAxis?: string | null;
      createdBy?: string | null;
    }>();
    const label = (body.label ?? "").trim();
    const question = (body.question ?? "").trim();
    const answer = (body.answer ?? "").trim();
    if (!label || !question || !answer) {
      return c.json({ error: "label, question, answer required" }, 400);
    }
    if (label.length > 100) return c.json({ error: "label too long (<=100)" }, 400);
    if (question.length > 10000 || answer.length > 10000) {
      return c.json({ error: "question/answer too long (<=10000)" }, 400);
    }

    const [ins] = await conn.query(
      `INSERT INTO hp_standard_answer
         (label, question, answer, project_id, source_post_id, source_axis, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        label,
        question,
        answer,
        body.projectId ?? null,
        body.sourcePostId ?? null,
        body.sourceAxis ?? null,
        body.createdBy ?? null,
      ],
    );
    return c.json({ ok: true, id: (ins as any).insertId }, 201);
  }),
);

// 목록 + 검색 (LIKE 기반 — 한국어 짧은 키워드 호환). FULLTEXT는 향후 ngram parser 도입 시 전환.
app.get("/standard-answers", async (c) =>
  withConn(c, async (conn) => {
    const q = (c.req.query("q") ?? "").trim();
    const projectId = c.req.query("projectId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

    const where: string[] = ["status = 1"];
    const params: any[] = [];
    if (projectId) {
      // 해당 프로젝트 전용 + 전사 공통(NULL) 모두 포함
      where.push("(project_id = ? OR project_id IS NULL)");
      params.push(parseInt(projectId, 10));
    }
    if (q) {
      where.push("(label LIKE ? OR question LIKE ? OR answer LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM hp_standard_answer ${whereSql}`,
      params,
    );
    const total = Number((countRows as any[])[0]?.total ?? 0);

    // 정렬: 해당 프로젝트 전용 우선 → 사용량 많은 순 → 최신
    const order = projectId
      ? "(project_id IS NOT NULL) DESC, usage_count DESC, created_at DESC"
      : "usage_count DESC, created_at DESC";

    const [rows] = await conn.query(
      `SELECT id, label, question, answer, project_id, source_post_id, source_axis,
              created_by, usage_count, last_used_at, created_at, updated_at
         FROM hp_standard_answer ${whereSql}
     ORDER BY ${order}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    return c.json({ total, limit, offset, rows });
  }),
);

app.get("/standard-answers/:id", async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const [rows] = await conn.query(
      `SELECT * FROM hp_standard_answer WHERE id = ? AND status = 1`,
      [id],
    );
    const r = (rows as any[])[0];
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(r);
  }),
);

app.patch("/standard-answers/:id", async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json<{
      label?: string;
      question?: string;
      answer?: string;
    }>();
    const sets: string[] = [];
    const params: any[] = [];
    for (const k of ["label", "question", "answer"] as const) {
      const v = body[k];
      if (v !== undefined) {
        const trimmed = String(v).trim();
        if (!trimmed) return c.json({ error: `${k} empty` }, 400);
        sets.push(`${k} = ?`);
        params.push(trimmed);
      }
    }
    if (!sets.length) return c.json({ error: "no fields" }, 400);
    params.push(id);
    const [result] = await conn.query(
      `UPDATE hp_standard_answer SET ${sets.join(", ")} WHERE id = ? AND status = 1`,
      params,
    );
    return c.json({ ok: true, affected: (result as any).affectedRows, changed: (result as any).changedRows });
  }),
);

app.delete("/standard-answers/:id", async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
    await conn.query(
      `UPDATE hp_standard_answer SET status = -1 WHERE id = ?`,
      [id],
    );
    return c.json({ ok: true });
  }),
);

// 챗봇이 답변을 사용했을 때 usage_count 증가용 (Phase 2 챗봇 도입 시 호출)
app.post("/standard-answers/:id/use", async (c) =>
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

// 게시글(문의) 1건 + 작성자 + (공개) 댓글 흐름.
// 직원/고객 구분은 email 도메인(@malgnsoft.com) 기준. private_yn='Y' 댓글 본문은 마스킹.
app.get("/pms/posts/:id", async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    const [postRows] = await conn.query(
      `SELECT p.id, p.subject, p.content, p.project_id, p.site_id,
              p.writer, p.reg_date, p.comm_cnt,
              u.email AS writer_email, u.company AS writer_company,
              (u.email LIKE '%@malgnsoft.com') AS writer_is_staff
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
              (u.email LIKE '%@malgnsoft.com') AS writer_is_staff
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

app.put("/wbs", async (c) => {
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

export default app;
