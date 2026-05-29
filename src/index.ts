import { Hono } from "hono";
import { cors } from "hono/cors";
import { createConnection } from "mysql2/promise";
import { openapiSpec, docHtml } from "./openapi";

type Bindings = {
  R2: R2Bucket;
  HYPERDRIVE: Hyperdrive;
  // AI: Ai;
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

// 프로젝트 단위 브리핑 (PMS BriefingCard용).
// DB로 만들 수 있는 통계·멤버·라벨·알림만 채우고, LLM 영역(faq/policies/hotTopics)은 빈 배열.
app.get("/pms/projects/:id/briefing", async (c) =>
  withConn(c, async (conn) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    const [projRows] = await conn.query(
      `SELECT id, name, description, buyer, start_date, end_date, status
         FROM tb_project WHERE id = ?`,
      [id],
    );
    const proj = (projRows as any[])[0];
    if (!proj) return c.json({ error: "not found" }, 404);

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

    return c.json({ briefing });
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
