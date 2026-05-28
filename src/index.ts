import { Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = {
  WBS_DB: D1Database;
  // HYPERDRIVE: Hyperdrive;
  // R2: R2Bucket;
  // AI: Ai;
};

const app = new Hono<{ Bindings: Bindings }>();

// 외부 도메인(malgn-helper-pms.pages.dev 등)에서 fetch 가능하도록 CORS 허용
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      // malgnsoft 소속 도메인 모두 허용 + 로컬 개발
      if (
        origin.endsWith(".pages.dev") ||
        origin.endsWith(".malgnsoft.com") ||
        origin.startsWith("http://localhost")
      ) {
        return origin;
      }
      return "";
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 600,
  }),
);

app.get("/", (c) => c.json({ name: "malgn-helper-api", status: "ok" }));
app.get("/healthz", (c) => c.json({ ok: true }));

// ============ WBS ============

type DbStage = {
  id: string;
  phase: number;
  name: string;
  weight: number;
  progress: number;
  summary: string | null;
  sort_order: number;
};

type DbTask = {
  id: string;
  stage_id: string;
  task_no: string;
  title: string;
  status: string;
  note: string | null;
  target_date: string | null;
  completion_date: string | null;
  sort_order: number;
};

// 전체 WBS 트리 조회 — stages + 각 stage의 tasks 배열
app.get("/wbs", async (c) => {
  const stagesRes = await c.env.WBS_DB.prepare(
    "SELECT id, phase, name, weight, progress, summary, sort_order FROM wbs_stages ORDER BY phase, sort_order",
  ).all<DbStage>();

  const tasksRes = await c.env.WBS_DB.prepare(
    "SELECT id, stage_id, task_no, title, status, note, target_date, completion_date, sort_order FROM wbs_tasks ORDER BY stage_id, sort_order",
  ).all<DbTask>();

  const tasksByStage = new Map<string, DbTask[]>();
  for (const t of tasksRes.results ?? []) {
    const list = tasksByStage.get(t.stage_id) ?? [];
    list.push(t);
    tasksByStage.set(t.stage_id, list);
  }

  const stages = (stagesRes.results ?? []).map((s) => ({
    id: s.id,
    phase: s.phase,
    name: s.name,
    weight: s.weight,
    progress: s.progress,
    summary: s.summary,
    tasks: (tasksByStage.get(s.id) ?? []).map((t) => ({
      id: t.id,
      taskNo: t.task_no,
      title: t.title,
      status: t.status,
      note: t.note,
      targetDate: t.target_date,
      completionDate: t.completion_date,
    })),
  }));

  return c.json({ stages });
});

// 작업 항목 부분 수정 (status / dates / note)
app.patch("/wbs/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    status?: string;
    note?: string | null;
    targetDate?: string | null;
    completionDate?: string | null;
  }>();

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.status !== undefined) {
    if (!["done", "in_progress", "pending", "blocked"].includes(body.status)) {
      return c.json({ error: "invalid status" }, 400);
    }
    updates.push("status = ?");
    values.push(body.status);
  }
  if (body.note !== undefined) {
    updates.push("note = ?");
    values.push(body.note);
  }
  if (body.targetDate !== undefined) {
    updates.push("target_date = ?");
    values.push(body.targetDate);
  }
  if (body.completionDate !== undefined) {
    updates.push("completion_date = ?");
    values.push(body.completionDate);
  }

  if (updates.length === 0) return c.json({ error: "no fields to update" }, 400);

  updates.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  const res = await c.env.WBS_DB.prepare(
    `UPDATE wbs_tasks SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...values)
    .run();

  if (!res.success) return c.json({ error: "update failed" }, 500);
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// 단계(stage) 진행률·요약 수정
app.patch("/wbs/stages/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ progress?: number; summary?: string }>();

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.progress !== undefined) {
    if (typeof body.progress !== "number" || body.progress < 0 || body.progress > 100) {
      return c.json({ error: "progress must be 0..100" }, 400);
    }
    updates.push("progress = ?");
    values.push(body.progress);
  }
  if (body.summary !== undefined) {
    updates.push("summary = ?");
    values.push(body.summary);
  }

  if (updates.length === 0) return c.json({ error: "no fields to update" }, 400);

  updates.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  const res = await c.env.WBS_DB.prepare(
    `UPDATE wbs_stages SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...values)
    .run();

  if (!res.success) return c.json({ error: "update failed" }, 500);
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

export default app;
