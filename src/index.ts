import { Hono } from "hono";

type Bindings = {
  // HYPERDRIVE: Hyperdrive;
  // R2: R2Bucket;
  // AI: Ai;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.json({ name: "malgn-helper-api", status: "ok" }));

app.get("/healthz", (c) => c.json({ ok: true }));

export default app;
