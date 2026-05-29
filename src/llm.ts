// src/llm.ts
// OpenAI 호출 (Cloudflare AI Gateway 경유). JSON-mode 응답 강제.

export type LlmEnv = {
  AI_GATEWAY_URL: string; // https://gateway.ai.cloudflare.com/v1/<acc>/<gw>/compat
  AI_GATEWAY_TOKEN?: string; // Authenticated Gateway 사용 시 cf-aig-authorization
  OPENAI_API_KEY: string;
  LLM_MODEL_DEFAULT: string;
  LLM_MODEL_PREMIUM: string;
};

export type LlmResult<T> = {
  data: T;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: number;
};

// OpenAI 공시 가격(2024-2025, USD per 1M tokens). 모델 추가 시 여기 갱신.
const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o":      { input: 2.5,  output: 10 },
};

function estimateCost(model: string, pin: number, pout: number): number {
  // model이 "openai/gpt-4o-mini" 같은 prefix 형식일 수 있음
  const base = model.includes("/") ? model.split("/").slice(-1)[0] : model;
  const p = PRICING[base];
  if (!p) return 0;
  return ((pin * p.input) + (pout * p.output)) / 1_000_000;
}

export async function callOpenAiJson<T>(
  env: LlmEnv,
  opts: {
    model?: string;
    system: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  },
): Promise<LlmResult<T>> {
  const model = opts.model ?? env.LLM_MODEL_DEFAULT;
  const url = `${env.AI_GATEWAY_URL}/chat/completions`;
  const t0 = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    };
    if (env.AI_GATEWAY_TOKEN) {
      headers["cf-aig-authorization"] = `Bearer ${env.AI_GATEWAY_TOKEN}`;
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        response_format: { type: "json_object" },
        max_tokens: opts.maxTokens ?? 800,
        temperature: opts.temperature ?? 0.2,
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const content = payload.choices?.[0]?.message?.content ?? "{}";
    const data = JSON.parse(content) as T;
    const promptTokens = payload.usage?.prompt_tokens ?? 0;
    const completionTokens = payload.usage?.completion_tokens ?? 0;
    return {
      data,
      model,
      promptTokens,
      completionTokens,
      latencyMs,
      costUsd: estimateCost(model, promptTokens, completionTokens),
    };
  } finally {
    clearTimeout(timer);
  }
}
