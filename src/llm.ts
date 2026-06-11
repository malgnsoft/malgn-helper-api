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

// Workers AI binding 타입 — Cloudflare Workers types 모자랄 때 안전망.
type WorkersAi = {
  run: (model: string, input: any, opts?: any) => Promise<any>;
};

/**
 * Cloudflare Workers AI binding 경유 호출.
 * - region 제한 없음 (Cloudflare 인프라)
 * - $10 크레딧 사용
 * - openai/o4-mini 같은 OpenAI partner 모델도 binding으로 동작
 *
 * o4-mini는 reasoning 모델 — temperature는 1로 고정, response_format 일부 미지원.
 * JSON 보장은 prompt 측에서 강제하고, 응답이 JSON이 아닐 경우 첫 { 부터 마지막 } 까지 추출.
 */
export async function callWorkersAi<T>(
  ai: WorkersAi,
  opts: {
    model: string;
    system: string;
    user: string;
    images?: string[];
    maxTokens?: number;
    temperature?: number;
  },
): Promise<LlmResult<T>> {
  const t0 = Date.now();
  // 모델 ID 결정:
  //   - `@cf/`·`@hf/`로 시작하면 그대로
  //   - `openai/`·`anthropic/`·`google/` 등 vendor prefix면 그대로 (partner 모델)
  //   - 그 외는 `@cf/` 자동 prefix
  const VENDOR_PREFIXES = ["openai/", "anthropic/", "google/", "mistral/"];
  const hasVendor = VENDOR_PREFIXES.some((v) => opts.model.startsWith(v));
  const model = opts.model.startsWith("@") || hasVendor ? opts.model : `@cf/${opts.model}`;
  const isPartner = hasVendor; // partner 모델은 OpenAI 호환 messages 형식 사용
  const isReasoning = /^openai\/o\d+/.test(opts.model);

  // Partner 모델(OpenAI 등)은 messages 형식 + response_format 지원.
  // Cloudflare 자체 모델(Llama 등)은 prompt 단일 string 형식이 호환성 가장 안전.
  let input: any;
  if (isPartner) {
    const userContent: any =
      opts.images && opts.images.length > 0
        ? [
            { type: "text", text: opts.user },
            ...opts.images.map((u) => ({ type: "image_url", image_url: { url: u, detail: "low" } })),
          ]
        : opts.user;
    input = {
      messages: [
        { role: isReasoning ? "developer" : "system", content: opts.system },
        { role: "user", content: userContent },
      ],
    };
    if (isReasoning) {
      input.max_completion_tokens = opts.maxTokens ?? 8000;
    } else {
      input.max_tokens = opts.maxTokens ?? 8000;
      input.temperature = opts.temperature ?? 0.3;
      input.response_format = { type: "json_object" };
    }
  } else {
    const combinedPrompt = `${opts.system}\n\n${String(opts.user)}`;
    input = { prompt: combinedPrompt };
    if (isReasoning) {
      input.max_completion_tokens = opts.maxTokens ?? 8000;
    } else {
      input.max_tokens = opts.maxTokens ?? 8000;
      input.temperature = opts.temperature ?? 0.3;
    }
  }

  const resp: any = await ai.run(model, input);
  // 응답 형태가 모델마다 다름 — 안전 추출
  let text = "";
  if (typeof resp === "string") {
    text = resp;
  } else if (typeof resp?.response === "string") {
    text = resp.response;
  } else if (typeof resp?.choices?.[0]?.message?.content === "string") {
    text = resp.choices[0].message.content;
  } else if (Array.isArray(resp?.choices?.[0]?.message?.content)) {
    text = resp.choices[0].message.content.map((c: any) => c?.text ?? "").join("");
  } else if (typeof resp?.text === "string") {
    text = resp.text;
  } else {
    // 디버그: 응답 구조 노출 후 throw
    throw new Error(`Workers AI 응답 파싱 실패. resp keys: ${Object.keys(resp ?? {}).join(",")} / sample: ${JSON.stringify(resp).slice(0, 400)}`);
  }

  // JSON 추출 (응답이 ```json … ``` 또는 평문으로 둘러쌌을 경우 대비)
  const jsonStr = (() => {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) return trimmed;
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
    return "{}";
  })();

  const data = JSON.parse(jsonStr) as T;

  return {
    data,
    model,
    promptTokens: resp?.usage?.prompt_tokens ?? 0,
    completionTokens: resp?.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
    // Workers AI 자체 단가는 모델별로 다양 — 0으로 기록 (정확 비용은 Cloudflare 대시보드에서)
    costUsd: 0,
  };
}

// OpenAI 공시 가격(USD per 1M tokens). 모델 추가 시 여기 갱신.
const PRICING: Record<string, { input: number; output: number }> = {
  // gpt-4.1 계열 (2025) — 현재 운영 모델 LLM_MODEL_DEFAULT/PREMIUM = openai/gpt-4.1-mini
  "gpt-4.1":      { input: 2.0,  output: 8.0 },
  "gpt-4.1-mini": { input: 0.4,  output: 1.6 },
  "gpt-4.1-nano": { input: 0.1,  output: 0.4 },
  // gpt-4o 계열
  "gpt-4o-mini":  { input: 0.15, output: 0.6 },
  "gpt-4o":       { input: 2.5,  output: 10 },
};

function estimateCost(model: string, pin: number, pout: number): number {
  // model이 "openai/gpt-4.1-mini" 같은 vendor prefix 형식일 수 있음 → 마지막 segment 사용
  const base = model.includes("/") ? model.split("/").slice(-1)[0] : model;
  // 정확 매칭 우선, 없으면 날짜 suffix(예: gpt-4.1-mini-2025-04-14) 등 변형 대비 최장 prefix 매칭
  let p = PRICING[base];
  if (!p) {
    const key = Object.keys(PRICING)
      .filter((k) => base.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key) p = PRICING[key];
  }
  if (!p) return 0;
  return ((pin * p.input) + (pout * p.output)) / 1_000_000;
}

export async function callOpenAiJson<T>(
  env: LlmEnv,
  opts: {
    model?: string;
    system: string;
    user: string;
    /** Image URLs to attach to the user message (GPT-4o Vision). When provided, model auto-upgrades to gpt-4o if caller still passes mini. */
    images?: string[];
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  },
): Promise<LlmResult<T>> {
  const hasImages = !!(opts.images && opts.images.length > 0);
  // Vision requires gpt-4o (mini doesn't support image_url). Auto-upgrade.
  const requestedModel = opts.model ?? env.LLM_MODEL_DEFAULT;
  const model = hasImages && requestedModel.includes("mini")
    ? (env.LLM_MODEL_PREMIUM || "gpt-4o")
    : requestedModel;
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
    const userContent: any = hasImages
      ? [
          { type: "text", text: opts.user },
          ...opts.images!.map((u) => ({
            type: "image_url",
            image_url: { url: u, detail: "low" }, // low = ~85 tokens/이미지
          })),
        ]
      : opts.user;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: userContent },
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
