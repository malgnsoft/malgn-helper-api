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

    const where: string[] = ["p.id > 0"]; // 시스템/임시 row 제외
    const params: any[] = [];
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

    // ── LLM: hotTopics 군집화 ────────────────────────────
    let generator: "db_only" | "hybrid" = "db_only";
    let llmModel: string | null = null;
    let llmPromptTokens: number | null = null;
    let llmCompletionTokens: number | null = null;
    let llmLatencyMs: number | null = null;
    let llmCostUsd: number | null = null;
    let llmError: string | null = null;

    if (!skipLlm && c.env.OPENAI_API_KEY) {
      try {
        const [titleRows] = await conn.query(
          `SELECT subject FROM tb_post
            WHERE project_id = ? AND status = 1 AND subject IS NOT NULL AND subject != ''
         ORDER BY reg_date DESC LIMIT 100`,
          [id],
        );
        const titles = (titleRows as any[])
          .map((r) => String(r.subject ?? "").trim())
          .filter((t) => t.length > 0);

        if (titles.length >= 5) {
          const llm = await callOpenAiJson<{ topics: Array<{ name: string; count: number }> }>(
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
          briefing.hotTopics = (llm.data.topics ?? []).slice(0, 7);
          generator = "hybrid";
          llmModel = llm.model;
          llmPromptTokens = llm.promptTokens;
          llmCompletionTokens = llm.completionTokens;
          llmLatencyMs = llm.latencyMs;
          llmCostUsd = llm.costUsd;
        }
      } catch (e) {
        llmError = (e as Error).message;
        // hotTopics는 빈 배열로 두고 generator=db_only 유지 → graceful degrade
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
