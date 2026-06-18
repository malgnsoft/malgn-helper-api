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
    { name: "announces", description: "표준 안내답변 — 직원 작성 공지·안내 카탈로그 (hp_announce)" },
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

    "/pms/projects/{id}": {
      get: {
        tags: ["pms"],
        summary: "프로젝트 단건 메타",
        description: "`tb_project` + `tb_project_group` JOIN. 이름·발주처·그룹명·기간·누적 포스트·마지막 활동.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          "200": { description: "프로젝트 메타" },
          "400": { description: "invalid id" },
          "404": { description: "없음" },
        },
      },
    },

    "/pms/projects/{id}/posts": {
      get: {
        tags: ["pms"],
        summary: "프로젝트의 게시글 목록 (검색·필터·페이지네이션)",
        description: "각 행에 작성자 분류(staff/partner/customer) + 미응답 표기. 협력사 화이트리스트는 응답 단계에서 매칭.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "q", in: "query", required: false, schema: { type: "string" }, description: "제목/작성자 LIKE" },
          { name: "filter", in: "query", required: false, schema: { type: "string", enum: ["", "customer", "unanswered"] } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50, maximum: 200 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "목록" } },
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
        summary: "표준 답변 저장 (항상 draft)",
        description:
          "QaEvalCard 'Save as standard answer' 액션의 destination. `hp_standard_answer` INSERT.\n\n" +
          "**항상 `approval_status='draft'`로 저장**(무검증 답변 챗봇 직행 방지, 큐레이션 §3-4). " +
          "분류(`scope/topicId/serviceId/tags`)는 선택. `topicId/serviceId`는 `hp_topic/hp_service` 존재·active 검증. " +
          "응답에 유사 표준답변 `similar[]`(중복 경고용, §4-1) 동봉.",
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
                  scope: { type: ["string", "null"], enum: ["common", "service", null], description: "분류 §2-1" },
                  topicId: { type: ["integer", "null"], description: "hp_topic.id (앱 검증)" },
                  serviceId: { type: ["integer", "null"], description: "hp_service.id (scope=service)" },
                  tags: { type: ["array", "null"], items: { type: "string" }, description: "자유 태그 배열" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "생성",
            content: { "application/json": { example: { ok: true, id: 1, approvalStatus: "draft", similar: [] } } },
          },
          "400": { description: "필수 필드 누락 / 길이 초과 / 분류 검증 실패" },
        },
      },
      get: {
        tags: ["standard-answers"],
        summary: "표준 답변 목록·검색",
        description:
          "활성(status=1) 표준 답변. `projectId` 지정 시 해당 프로젝트 전용 + 전사 공통(NULL) 모두 포함. " +
          "분류 필터(`scope/topicId/serviceId/approvalStatus`) + `search`(또는 레거시 `q`) LIKE. " +
          "응답 행에 `topic_slug/topic_label/service_slug/service_name`(LEFT JOIN) + `tags`(배열) 포함.",
        parameters: [
          { name: "search", in: "query", required: false, schema: { type: "string" }, description: "label/question/answer LIKE (레거시 q 호환)" },
          { name: "q", in: "query", required: false, schema: { type: "string" }, description: "레거시 별칭" },
          { name: "scope", in: "query", required: false, schema: { type: "string", enum: ["common", "service"] } },
          { name: "topicId", in: "query", required: false, schema: { type: "integer" } },
          { name: "serviceId", in: "query", required: false, schema: { type: "integer" } },
          { name: "approvalStatus", in: "query", required: false, schema: { type: "string", enum: ["draft", "reviewing", "approved", "rejected", "archived"] } },
          { name: "projectId", in: "query", required: false, schema: { type: "integer" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "목록" } },
      },
    },

    "/standard-answers/check-duplicate": {
      post: {
        tags: ["standard-answers"],
        summary: "중복 감지 — 유사 질문 표준답변 top N (§4-1)",
        description:
          "질문 유사도로 기존 표준답변 후보를 반환. **OpenSearch k-NN 전환 대상(§4-1, T2)** — 현재는 LIKE+토큰 자카드 MVP. 가드 developer↑.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["question"],
                properties: {
                  question: { type: "string" },
                  topicId: { type: ["integer", "null"] },
                  serviceId: { type: ["integer", "null"] },
                  limit: { type: "integer", default: 5, maximum: 20 },
                },
              },
            },
          },
        },
        responses: { "200": { description: "유사 후보", content: { "application/json": { example: { similar: [] } } } }, "400": { description: "question 누락" } },
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

    "/standard-answers/{id}/transition": {
      patch: {
        tags: ["standard-answers"],
        summary: "승인 워크플로 상태 전이 (§3-2/§3-3)",
        description:
          "전이표 검증: draft→reviewing/rejected · reviewing→approved/rejected · approved→archived · rejected→draft · archived→reviewing. " +
          "위반 시 422. `approved` 시 `approved_by`(세션)·`approved_at=NOW()` 기록. `rejected` 시 `reason` 필수. 가드 developer↑.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["to"],
                properties: {
                  to: { type: "string", enum: ["draft", "reviewing", "approved", "rejected", "archived"] },
                  reason: { type: "string", description: "rejected 시 필수" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "전이 완료", content: { "application/json": { example: { ok: true, id: 1, from: "reviewing", to: "approved" } } } },
          "400": { description: "잘못된 to / 반려 사유 누락" },
          "404": { description: "없음" },
          "422": { description: "전이표 위반" },
        },
      },
    },

    "/standard-answers/{id}/merge": {
      post: {
        tags: ["standard-answers"],
        summary: "중복 병합 — secondary(:id)→primary(intoId) (§4-2)",
        description:
          "secondary 흡수: `status=-1` + `merged_into_id`. primary: `usage_count` 합산·`last_used_at` 최신·`tags` 합집합·출처 승계. 가드 admin.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 }, description: "흡수될 secondary id" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["intoId"],
                properties: { intoId: { type: "integer", minimum: 1, description: "생존할 primary id" } },
              },
            },
          },
        },
        responses: {
          "200": { description: "병합 완료", content: { "application/json": { example: { ok: true, primaryId: 2, secondaryId: 1, usageCount: 7 } } } },
          "400": { description: "intoId 누락 / self 병합" },
          "404": { description: "primary/secondary 없음" },
        },
      },
    },

    "/announces": {
      get: {
        tags: ["announces"],
        summary: "표준 안내답변 목록·검색 (hp_announce)",
        description:
          "직원 작성 공지·안내(안내글) 카탈로그. 분류 필터(`scope/topicId/serviceId/approvalStatus`) + `search`(title/label/body/question LIKE). " +
          "응답 행에 `topic_slug/topic_label/service_slug/service_name`(LEFT JOIN) + `tags`(배열) + **`answer`(=body 매핑, admin SA UI 재사용)** 포함. 가드 developer↑.",
        parameters: [
          { name: "search", in: "query", required: false, schema: { type: "string" }, description: "title/label/body/question LIKE (레거시 q 호환)" },
          { name: "scope", in: "query", required: false, schema: { type: "string", enum: ["common", "service"] } },
          { name: "topicId", in: "query", required: false, schema: { type: "integer" } },
          { name: "serviceId", in: "query", required: false, schema: { type: "integer" } },
          { name: "approvalStatus", in: "query", required: false, schema: { type: "string", enum: ["draft", "reviewing", "approved", "rejected", "archived"] } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "목록", content: { "application/json": { example: { total: 0, limit: 20, offset: 0, rows: [] } } } } },
      },
      post: {
        tags: ["announces"],
        summary: "표준 안내답변 저장 (항상 draft)",
        description:
          "안내글 채택분 `hp_announce` INSERT. **항상 `approval_status='draft'`**(§3-4). " +
          "`title`/`body` 필수, `question` 선택(NULL 허용). 본문은 `body` 우선, 없으면 `answer`(SA UI 별칭) 수용. " +
          "이미지 경로 절대화(`absolutizePmsAssets`). 분류(`scope/topicId/serviceId/tags`) 선택 — `topicId/serviceId` 존재·active 검증. " +
          "가드 `requireServiceToken`(PMS 임베드).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title", "body"],
                properties: {
                  title: { type: "string", maxLength: 150, description: "안내 주제/제목" },
                  label: { type: ["string", "null"], maxLength: 100, description: "분류 라벨(선택)" },
                  question: { type: ["string", "null"], maxLength: 10000, description: "안내글엔 없을 수 있음(NULL 허용)" },
                  body: { type: "string", maxLength: 10000, description: "안내 본문(= 답변 콘텐츠)" },
                  answer: { type: ["string", "null"], description: "body 별칭(admin SA UI 호환)" },
                  sourcePostId: { type: ["integer", "null"], description: "파생 PMS tb_post.id(staff 첫 글)" },
                  createdBy: { type: ["string", "null"], description: "저장 직원 email" },
                  scope: { type: ["string", "null"], enum: ["common", "service", null] },
                  topicId: { type: ["integer", "null"], description: "hp_topic.id (앱 검증)" },
                  serviceId: { type: ["integer", "null"], description: "hp_service.id (scope=service)" },
                  tags: { type: ["array", "null"], items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "생성", content: { "application/json": { example: { ok: true, id: 1, approvalStatus: "draft" } } } },
          "400": { description: "title/body 누락 / 길이 초과 / 분류 검증 실패" },
        },
      },
    },

    "/announces/{id}": {
      get: {
        tags: ["announces"],
        summary: "표준 안내답변 단건",
        description: "`tags` 배열 + `answer`(=body 매핑) 동봉.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": { description: "OK" }, "404": { description: "없음" } },
      },
      patch: {
        tags: ["announces"],
        summary: "표준 안내답변 부분 수정",
        description: "`title/label/body(answer)/question` + 분류(`scope/topicId/serviceId/tags`) 중 보낸 필드만 갱신. body 이미지 절대화. 가드 admin.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string", maxLength: 150 },
                  label: { type: ["string", "null"], maxLength: 100 },
                  body: { type: "string", maxLength: 10000 },
                  answer: { type: ["string", "null"], description: "body 별칭" },
                  question: { type: ["string", "null"], maxLength: 10000 },
                  scope: { type: ["string", "null"], enum: ["common", "service", null] },
                  topicId: { type: ["integer", "null"] },
                  serviceId: { type: ["integer", "null"] },
                  tags: { type: ["array", "null"], items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: { "200": { description: "OK" }, "400": { description: "필드 없음/빈 값" } },
      },
      delete: {
        tags: ["announces"],
        summary: "표준 안내답변 soft-delete (status=-1)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": { description: "OK" } },
      },
    },

    "/announces/{id}/transition": {
      patch: {
        tags: ["announces"],
        summary: "안내답변 승인 워크플로 상태 전이 (§3-2/§3-3)",
        description:
          "SA 전이표 재사용: draft→reviewing/rejected · reviewing→approved/rejected · approved→archived · rejected→draft · archived→reviewing. " +
          "위반 시 422. `approved` 시 `approved_by`(세션)·`approved_at=NOW()`. `rejected` 시 `reason` 필수. 가드 developer↑.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["to"],
                properties: {
                  to: { type: "string", enum: ["draft", "reviewing", "approved", "rejected", "archived"] },
                  reason: { type: "string", description: "rejected 시 필수" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "전이 완료", content: { "application/json": { example: { ok: true, id: 1, from: "reviewing", to: "approved" } } } },
          "400": { description: "잘못된 to / 반려 사유 누락" },
          "404": { description: "없음" },
          "422": { description: "전이표 위반" },
        },
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
