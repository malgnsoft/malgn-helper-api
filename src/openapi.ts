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

    "/pms/projects": {
      get: {
        tags: ["pms"],
        summary: "프로젝트 목록 + 간이 통계",
        description:
          "활성(`status=1`) + `id>0`인 프로젝트 기본 목록. 각 행에 게시글 수·최근 활동 포함.",
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
        summary: "프로젝트 단위 브리핑",
        description:
          "PMS BriefingCard용 집계. DB로 산출 가능한 통계·멤버·라벨·알림을 채움.\n\n" +
          "**LLM 필요 항목은 빈 배열**: `hotTopics`, `faq`, `policies`, `stats.urgent=0`.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          "200": {
            description: "브리핑",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BriefingEnvelope" },
              },
            },
          },
          "400": { description: "invalid id" },
          "404": { description: "프로젝트 없음" },
        },
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
