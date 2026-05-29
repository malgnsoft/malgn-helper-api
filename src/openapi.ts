// src/openapi.ts
// malgn-helper-api OpenAPI 3.1 스펙 (수동 작성)
// 변경 시 src/index.ts의 실제 라우트와 동기화 필요.

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Malgn Helper API",
    version: "0.1.0",
    description:
      "맑은소프트 CS 솔루션용 AI 헬퍼 백엔드 API.\n\n" +
      "## 책임 범위\n\n" +
      "- **WBS Live Tracker** 영속화 (R2에 단일 JSON 저장)\n" +
      "- **PMS 게시판 연동** — 프로젝트 목록 / 단건 게시글 / 프로젝트 단위 브리핑\n" +
      "- 향후: 표준 답변·자료 인덱싱, LLM 게이트웨이, 챗봇 응답\n\n" +
      "## 인프라\n\n" +
      "- 런타임: Cloudflare Workers + Hono\n" +
      "- 영속화: **Cloudflare R2** (`malgn-helper-files`)\n" +
      "- DB: **Cloudflare Hyperdrive** → 외부 MySQL (PMS 테스트 DB)\n" +
      "- 추후: AI Gateway → Claude, OpenSearch (k-NN + BM25)\n\n" +
      "## 인증\n\n" +
      "현재 MVP — **인증 없음**. 사내 운영자만 URL을 알도록 운영하고, 공개 도메인에 둘 경우 Cloudflare Access로 별도 보호 권장.\n\n" +
      "## 응답 형식\n\n" +
      "- 성공: 자원에 맞는 JSON\n" +
      "- 에러: `{ \"error\": string, \"stack\"?: string[] }`\n\n" +
      "## 분류 규칙\n\n" +
      "직원/고객 구분은 **`@malgnsoft.com`** 이메일 도메인 기준. 비공개 댓글(`private_yn='Y'`)의 본문은 응답에서 마스킹됨.\n\n" +
      "## 관련 문서\n\n" +
      "- WBS Tracker 빌드 가이드: `doc/WBS-TRACKER.md`\n" +
      "- 진행 이력: `doc/history/`",
  },
  servers: [
    { url: "https://malgn-helper-api.malgnsoft.workers.dev", description: "Production" },
  ],
  tags: [
    { name: "health", description: "헬스체크" },
    { name: "wbs", description: "WBS Live Tracker — R2 단일 JSON 영속화" },
    { name: "pms", description: "PMS 게시판 연동 (Hyperdrive → MySQL)" },
    { name: "standard-answers", description: "표준 답변 카탈로그 — 챗봇 응답 1순위 소스 (hp_standard_answer)" },
    { name: "admin", description: "운영 도구 (LLM 비용·호출 집계 등)" },
    { name: "db", description: "탐색용 임시 엔드포인트 (안정화 후 제거 예정)" },
  ],
  paths: {
    "/": {
      get: {
        tags: ["health"],
        summary: "루트",
        description: "서비스 식별자 응답.",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ServiceInfo" },
                example: { name: "malgn-helper-api", status: "ok" },
              },
            },
          },
        },
      },
    },
    "/healthz": {
      get: {
        tags: ["health"],
        summary: "헬스체크",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { example: { ok: true } } },
          },
        },
      },
    },

    "/wbs": {
      get: {
        tags: ["wbs"],
        summary: "WBS 문서 조회",
        description:
          "R2의 `wbs/wbs.json`을 그대로 반환. 페이지(`malgn-helper-pms/wbs`) 초기 로드용.\n\n" +
          "최초에는 R2가 비어 404. 페이지가 `public/wbs.json` 시드를 한 번 보낸 뒤 200으로 전환됨.",
        responses: {
          "200": {
            description: "WBS 문서",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WbsDoc" } } },
          },
          "404": {
            description: "R2에 wbs.json 없음",
            content: { "application/json": { example: { exists: false } } },
          },
        },
      },
      put: {
        tags: ["wbs"],
        summary: "WBS 문서 저장 (전체 덮어쓰기)",
        description:
          "프론트엔드 인라인 편집의 800ms 디바운스 후 호출됨. **last-write-wins**.\n\n" +
          "- 1MB 초과 시 413\n- JSON 파싱 실패 시 400",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/WbsDoc" } } },
        },
        responses: {
          "200": {
            description: "저장 성공",
            content: {
              "application/json": {
                example: { ok: true, size: 13125, savedAt: "2026-05-29T01:18:14.176Z" },
              },
            },
          },
          "400": { description: "invalid json" },
          "413": { description: "payload too large" },
        },
      },
    },

    "/pms/groups": {
      get: {
        tags: ["pms"],
        summary: "프로젝트 그룹 목록 (셀렉트박스용)",
        description: "`tb_project_group` 활성 그룹 + 각 그룹의 활성 프로젝트 수. site 기본 1.",
        parameters: [
          { name: "siteId", in: "query", required: false, schema: { type: "string", default: "1" } },
        ],
        responses: { "200": { description: "그룹 목록" } },
      },
    },

    "/pms/projects": {
      get: {
        tags: ["pms"],
        summary: "프로젝트 목록 + 간이 통계",
        description:
          "활성(`status=1`) + `id>0` + `site_id=1`(기본)인 프로젝트. 각 행에 게시글 수·최근 활동 포함.",
        parameters: [
          {
            name: "q",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "프로젝트명/발주처 LIKE 검색",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", default: 50, minimum: 1, maximum: 200 },
          },
          {
            name: "offset",
            in: "query",
            required: false,
            schema: { type: "integer", default: 0, minimum: 0 },
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["active", "all"], default: "active" },
            description: "`all`이면 종료된 프로젝트 포함",
          },
          {
            name: "siteId",
            in: "query",
            required: false,
            schema: { type: "string", default: "1" },
            description: "기본 `1` (메인 사이트). `all`로 전체 사이트, 또는 특정 site_id 정수",
          },
          {
            name: "groupId",
            in: "query",
            required: false,
            schema: { type: "integer" },
            description: "`tb_project_group.id`로 필터. 미지정 시 전체 그룹",
          },
        ],
        responses: {
          "200": {
            description: "목록",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProjectList" },
              },
            },
          },
        },
      },
    },

    "/pms/projects/{id}/briefing": {
      get: {
        tags: ["pms"],
        summary: "프로젝트 단위 브리핑 (즉시 집계)",
        description:
          "캐시·저장 없이 매번 DB 집계. 빠른 미리보기·디버깅용. **운영 화면은 POST .../generate 사용 권장**.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          "200": { description: "브리핑", content: { "application/json": { schema: { $ref: "#/components/schemas/BriefingEnvelope" } } } },
          "400": { description: "invalid id" },
          "404": { description: "프로젝트 없음" },
        },
      },
    },

    "/pms/projects/{id}/standard-answer-suggestions": {
      post: {
        tags: ["pms"],
        summary: "표준답변 후보 자동 추출 (LLM)",
        description:
          "프로젝트의 직원(`@malgnsoft.com`) 응답 본문 50건을 모아 LLM이 반복 패턴을 분석. " +
          "각 후보는 `label/question/answer/frequency`로 반환. 저장은 사용자가 `POST /standard-answers`로 별도 호출.\n\n" +
          "**비공개 댓글(`private_yn='Y'`) 제외**. 30자 미만 짧은 응답 제외.\n\n" +
          "캐시: 미적용 (가끔 트리거되는 액션). `?force=1`로 향후 캐시 도입 시 우회.\n" +
          "비용 가이드: 1회당 약 $0.002 (≈ ₩3).",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "force", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          "200": {
            description: "후보 목록",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    suggestions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          label: { type: "string" },
                          question: { type: "string" },
                          answer: { type: "string" },
                          frequency: { type: "integer" },
                        },
                      },
                    },
                    sampleSize: { type: "integer" },
                    llm: { type: "object" },
                    note: { type: "string" },
                  },
                },
              },
            },
          },
          "502": { description: "LLM 호출 실패" },
          "503": { description: "OPENAI_API_KEY 미설정" },
        },
      },
    },

    "/pms/projects/{id}/briefing/generate": {
      post: {
        tags: ["pms"],
        summary: "브리핑 카드 생성 + 저장",
        description:
          "DB 집계 → `hp_briefing`에 새 row 저장. 같은 `llm_input_hash`가 **24시간 이내**에 있으면 캐시 hit으로 기존 row 재사용. `?force=1`로 우회. 모든 호출은 `hp_llm_log`에 기록됨.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "force", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          "200": {
            description: "생성/캐시 hit",
            content: {
              "application/json": {
                example: { briefing: "...", cached: false, id: 42 },
              },
            },
          },
          "404": { description: "프로젝트 없음" },
        },
      },
    },

    "/pms/projects/{id}/briefings": {
      get: {
        tags: ["pms"],
        summary: "저장된 브리핑 목록 (메타만)",
        description: "히스토리 selectbox용. `briefing_json`은 제외하고 메타만 반환.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 20, maximum: 100 } },
        ],
        responses: { "200": { description: "목록" } },
      },
    },

    "/pms/briefings/{id}": {
      get: {
        tags: ["pms"],
        summary: "저장된 브리핑 단건 (full json)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: {
          "200": { description: "단건", content: { "application/json": { schema: { $ref: "#/components/schemas/BriefingEnvelope" } } } },
          "404": { description: "없음" },
        },
      },
      delete: {
        tags: ["pms"],
        summary: "저장된 브리핑 soft-delete (status=-1)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": { description: "OK" } },
      },
    },

    "/admin/evals": {
      get: {
        tags: ["admin"],
        summary: "Q&A 평가 목록·정렬·필터",
        description: "`hp_qa_eval`에서 활성 평가 조회. `tb_post`/`tb_project` JOIN으로 제목·프로젝트명 포함.",
        parameters: [
          { name: "projectId", in: "query", required: false, schema: { type: "integer" } },
          { name: "minScore", in: "query", required: false, schema: { type: "number", minimum: 0, maximum: 5 } },
          { name: "maxScore", in: "query", required: false, schema: { type: "number", minimum: 0, maximum: 5 } },
          { name: "hasScore", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
          {
            name: "sort", in: "query", required: false,
            schema: { type: "string", enum: ["recent", "score_asc", "score_desc", "latency"], default: "recent" },
            description: "score_asc는 NULL을 뒤로 (취약 응대 우선 발견)",
          },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50, maximum: 200 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "목록" } },
      },
    },

    "/admin/cost": {
      get: {
        tags: ["admin"],
        summary: "LLM 호출 비용·지연·실패 집계",
        description:
          "`hp_llm_log`를 일·모델·엔티티 기준으로 집계 + 최근 N건. `/admin/cost` 대시보드 페이지가 호출.\n\n" +
          "**무인증** — 사내 운영자만 URL을 알도록 운영. Cloudflare Access 보호 권장.",
        parameters: [
          { name: "days", in: "query", required: false, schema: { type: "integer", default: 30, minimum: 1, maximum: 365 } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50, maximum: 200 }, description: "recent 호출 개수" },
        ],
        responses: {
          "200": {
            description: "집계",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    range: { type: "object", properties: { days: { type: "integer" } } },
                    summary: { type: "object" },
                    byModel: { type: "array", items: { type: "object" } },
                    byEntity: { type: "array", items: { type: "object" } },
                    byDay: { type: "array", items: { type: "object" } },
                    recent: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/standard-answers": {
      post: {
        tags: ["standard-answers"],
        summary: "표준 답변 저장",
        description: "QaEvalCard 'Save as standard answer' 액션의 destination. `hp_standard_answer` INSERT.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["label", "question", "answer"],
                properties: {
                  label: { type: "string", maxLength: 100 },
                  question: { type: "string", maxLength: 10000 },
                  answer: { type: "string", maxLength: 10000 },
                  projectId: { type: ["integer", "null"], description: "NULL = 전사 공통" },
                  sourcePostId: { type: ["integer", "null"] },
                  sourceAxis: { type: ["string", "null"], description: "QaEval A~E" },
                  createdBy: { type: ["string", "null"], description: "직원 email (인증 도입 후)" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "생성", content: { "application/json": { example: { ok: true, id: 1 } } } },
          "400": { description: "필수 필드 누락 / 길이 초과" },
        },
      },
      get: {
        tags: ["standard-answers"],
        summary: "표준 답변 목록·검색",
        description:
          "활성(status=1) 표준 답변. `projectId` 지정 시 해당 프로젝트 전용 + 전사 공통(NULL) 모두 포함. 검색은 LIKE (한국어 짧은 키워드 호환). FULLTEXT는 향후 ngram parser 도입 시 전환.",
        parameters: [
          { name: "q", in: "query", required: false, schema: { type: "string" }, description: "label/question/answer LIKE" },
          { name: "projectId", in: "query", required: false, schema: { type: "integer" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "목록" } },
      },
    },

    "/standard-answers/{id}": {
      get: {
        tags: ["standard-answers"],
        summary: "표준 답변 단건",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": { description: "OK" }, "404": { description: "없음" } },
      },
      patch: {
        tags: ["standard-answers"],
        summary: "표준 답변 부분 수정",
        description: "label/question/answer 중 보낸 필드만 갱신.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  label: { type: "string", maxLength: 100 },
                  question: { type: "string", maxLength: 10000 },
                  answer: { type: "string", maxLength: 10000 },
                },
              },
            },
          },
        },
        responses: { "200": { description: "OK" }, "400": { description: "필드 없음/빈 값" } },
      },
      delete: {
        tags: ["standard-answers"],
        summary: "표준 답변 soft-delete (status=-1)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": { description: "OK" } },
      },
    },

    "/standard-answers/{id}/use": {
      post: {
        tags: ["standard-answers"],
        summary: "사용 카운트 증가 (챗봇 호출용)",
        description: "Phase 2 챗봇이 답변을 사용할 때마다 호출. `usage_count` +1, `last_used_at` 갱신.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": { description: "OK" } },
      },
    },

    "/pms/posts/{id}/eval/generate": {
      post: {
        tags: ["pms"],
        summary: "Q&A 평가 카드 생성 + 저장 (LLM)",
        description:
          "게시글 + 첫 직원 응답을 LLM(`openai/gpt-4o-mini`)이 5축(A~E)으로 평가. `hp_qa_eval`에 저장 + `hp_llm_log` 기록. 같은 input_hash가 있으면 캐시 hit. `?force=1`로 우회.\n\n" +
          "**비공개 댓글(`private_yn='Y'`)은 LLM 입력에서 제외**되며, 첫 응답이 비공개인 경우 `meta.privateAnswer=true`로 표시.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "force", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          "200": { description: "생성/캐시 hit" },
          "404": { description: "post 없음" },
        },
      },
    },
    "/pms/posts/{id}/evals": {
      get: {
        tags: ["pms"],
        summary: "게시글에 저장된 평가 목록 (메타만)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 20, maximum: 100 } },
        ],
        responses: { "200": { description: "목록" } },
      },
    },
    "/pms/evals/{id}": {
      get: {
        tags: ["pms"],
        summary: "저장된 평가 단건",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": { description: "OK" }, "404": { description: "없음" } },
      },
      delete: {
        tags: ["pms"],
        summary: "평가 soft-delete (status=-1)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": { description: "OK" } },
      },
    },

    "/pms/posts/{id}": {
      get: {
        tags: ["pms"],
        summary: "게시글 단건 + (공개) 댓글",
        description:
          "직원/고객 분류(`writerIsStaff`) 포함. **비공개 댓글(`private_yn='Y'`)은 본문 null 처리**, 메타에 hidden count 제공.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          "200": {
            description: "게시글 + 댓글",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PostDetail" } } },
          },
          "400": { description: "invalid id" },
          "404": { description: "글 없음" },
        },
      },
    },

    "/db/ping": {
      get: {
        tags: ["db"],
        summary: "DB 연결 확인",
        description: "Hyperdrive → MySQL `SELECT 1, NOW(), VERSION()`.",
        responses: { "200": { description: "OK" } },
      },
    },
    "/db/whoami": {
      get: {
        tags: ["db"],
        summary: "DB/사용자 확인",
        description: "`SELECT DATABASE(), CURRENT_USER(), @@hostname, VERSION()`",
        responses: { "200": { description: "OK" } },
      },
    },
    "/db/tables": {
      get: {
        tags: ["db"],
        summary: "테이블 목록 (SHOW TABLES)",
        responses: { "200": { description: "OK" } },
      },
    },
    "/db/columns/{table}": {
      get: {
        tags: ["db"],
        summary: "테이블 컬럼 (DESCRIBE)",
        parameters: [{ name: "table", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "OK" },
          "400": { description: "invalid table" },
        },
      },
    },
    "/db/sample/{table}": {
      get: {
        tags: ["db"],
        summary: "테이블 샘플 (SELECT * LIMIT N)",
        parameters: [
          { name: "table", in: "path", required: true, schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", default: 5, minimum: 1, maximum: 20 },
          },
        ],
        responses: {
          "200": { description: "OK" },
          "400": { description: "invalid table" },
        },
      },
    },
  },

  components: {
    schemas: {
      ServiceInfo: {
        type: "object",
        properties: {
          name: { type: "string", example: "malgn-helper-api" },
          status: { type: "string", example: "ok" },
        },
      },
      WbsDoc: {
        type: "object",
        required: ["_meta", "phase1"],
        properties: {
          _meta: {
            type: "object",
            properties: {
              lastUpdated: { type: "string", description: "YYYY-MM-DD (저장 시 자동 갱신)" },
              project: { type: "string" },
              source: { type: "string" },
              editGuide: { type: "string" },
            },
          },
          phase1: {
            type: "object",
            properties: {
              stages: { type: "array", items: { $ref: "#/components/schemas/WbsStage" } },
            },
          },
        },
      },
      WbsStage: {
        type: "object",
        properties: {
          id: { type: "string", example: "P1-2" },
          name: { type: "string" },
          weight: { type: "integer", example: 21 },
          progress: { type: "integer", description: "0~100" },
          summary: { type: "string" },
          tasks: { type: "array", items: { $ref: "#/components/schemas/WbsTask" } },
        },
      },
      WbsTask: {
        type: "object",
        properties: {
          id: { type: "string", example: "P1-2-7" },
          taskNo: { type: "string", example: "2-7" },
          title: { type: "string" },
          status: { type: "string", enum: ["done", "in_progress", "pending", "blocked"] },
          note: { type: ["string", "null"] },
          targetDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
          completionDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
          deliverableUrl: { type: ["string", "null"] },
        },
      },
      ProjectListRow: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          buyer: { type: "string" },
          active: { type: "boolean" },
          postCount: { type: "integer" },
          lastActivity: { type: ["string", "null"], description: "ISO datetime" },
        },
      },
      ProjectList: {
        type: "object",
        properties: {
          total: { type: "integer" },
          limit: { type: "integer" },
          offset: { type: "integer" },
          rows: { type: "array", items: { $ref: "#/components/schemas/ProjectListRow" } },
        },
      },
      BriefingEnvelope: {
        type: "object",
        properties: {
          briefing: { type: "object", description: "BriefingCard용 풀 객체 (meta/customer/staff/stats/hotLabels/alerts/...)" },
        },
      },
      PostDetail: {
        type: "object",
        properties: {
          post: {
            type: "object",
            properties: {
              id: { type: "integer" },
              subject: { type: "string" },
              content: { type: "string" },
              projectId: { type: "integer" },
              siteId: { type: "integer" },
              writer: { type: "string" },
              writerCompany: { type: "string" },
              writerIsStaff: { type: "boolean" },
              regDate: { type: "string", description: "ISO" },
              commentCount: { type: "integer" },
            },
          },
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                writer: { type: "string" },
                writerIsStaff: { type: "boolean" },
                regDate: { type: "string" },
                isPrivate: { type: "boolean" },
                content: {
                  type: ["string", "null"],
                  description: "비공개(`isPrivate=true`) 댓글은 null",
                },
              },
            },
          },
          meta: {
            type: "object",
            properties: { privateCommentsHidden: { type: "integer" } },
          },
        },
      },
    },
  },
} as const;

export const docHtml = `<!doctype html>
<html>
  <head>
    <title>Malgn Helper API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script type="text/javascript">
      Scalar.createApiReference('#app', {
        "_integration": "hono",
        "url": "/doc/openapi.json",
        "theme": "default"
      })
    </script>
  </body>
</html>`;
