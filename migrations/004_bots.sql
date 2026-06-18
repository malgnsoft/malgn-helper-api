-- migrations/004_bots.sql
-- Malgn Helper — 봇(챗봇) 서비스별 구분 관리 — hp_bot 테이블
-- 실행 위치: 운영 PMS DB (실서버 221.143.42.213, MySQL 5.6.51-log, DB `pms`)
-- 설계 정본: malgn-helper-mng/docs/BOTS-PLAN.md §2 (DBA 스키마 요구사항)
-- 관련 데모 모델: malgn-helper-admin/composables/use-bots.ts (Bot 인터페이스 → 본 스키마로 1:1 대응)
-- 직전 마이그레이션: migrations/003_standard_answer_curation.sql
-- 안전성: CREATE TABLE IF NOT EXISTS + INSERT ... ON DUPLICATE KEY (멱등). tb_*/기존 hp_* 무영향.
-- 컨벤션(002·003 동일): utf8mb4 / status TINYINT(1=active,-1=deleted) / DATETIME / ENUM(5.6 지원).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 설계 결정 (BOTS-PLAN §2 + 기존 002/003 컨벤션 정합)
-- ─────────────────────────────────────────────────────────────────────────────
--  [소프트삭제] 002(hp_topic/service/setting/integration)·003 의 status TINYINT(1=active,-1=deleted)
--    컨벤션을 그대로 따른다. deleted_at 컬럼은 쓰지 않는다.
--    → use-bots.ts 의 status('active'|'inactive'|'draft')는 라이프사이클 상태이지 소프트삭제가 아니다.
--      003 이 approval_status(라이프사이클 ENUM) 와 status(소프트삭제 TINYINT)를 분리한 패턴과 동일하게,
--      여기서도 bot_status(ENUM, 운영 상태) 와 status(TINYINT, soft-delete) 를 분리한다.
--      DELETE 라우트는 status=-1 로 처리(BOTS-PLAN §3 소프트삭제).
--
--  [JSON 저장] 003 의 tags 와 동일하게 LONGTEXT NULL 로 둔다.
--    MySQL 5.6.51 은 네이티브 JSON 타입·JSON 표현식 DEFAULT 를 지원하지 않는다(8.0 기능).
--    traits/refusal_topics/topics 는 애플리케이션이 JSON 직렬화/역직렬화한다.
--    NULL = 미지정, '[]' = 빈 배열. (HP-SCHEMA §1-4 "LLM 결과·JSON 은 LONGTEXT + serialization" 원칙과 동일.)
--
--  [FK] service_id 는 hp_service.id 를 참조하지만 DB FK 제약은 걸지 않는다.
--    003 §4 "FK 미사용 — 정합성은 애플리케이션이 검증" 원칙과 동일. NULL = 공통(전 서비스) 봇.
--    인덱스(service_id)만 둔다.
--
--  [인덱스] BOTS-PLAN §2: service_id, status. 목록 조회는 (status, service_id) 복합으로 커버.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 롤백: DROP TABLE IF EXISTS hp_bot;  (시드 포함 전체 제거. 운영 데이터 있으면 주의)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hp_bot (
  id                    INT NOT NULL AUTO_INCREMENT,
  service_id            INT NULL
        COMMENT 'hp_service.id (FK 없음, 앱 검증). NULL = 공통(전 서비스) 봇 (§2)',

  -- ── 기본 ──
  name                  VARCHAR(100) NOT NULL COMMENT '봇 이름',
  avatar                VARCHAR(8) NULL COMMENT '이모지 1자 (utf8mb4)',
  description           VARCHAR(255) NULL COMMENT '봇 설명',
  bot_status            ENUM('active','inactive','draft') NOT NULL DEFAULT 'draft'
        COMMENT '운영 라이프사이클 상태. status(soft-delete)와 분리 (use-bots.ts status)',

  -- ── 페르소나 ──
  tone                  ENUM('formal','friendly','concise') NOT NULL DEFAULT 'friendly'
        COMMENT '말투: formal=정중체 friendly=친근체 concise=간결체',
  traits                LONGTEXT NULL
        COMMENT '성격 태그 배열 JSON 직렬화 (5.6 JSON 미지원 → LONGTEXT). NULL=미지정 "[]"=빈배열',
  greeting              TEXT NULL COMMENT '첫 인사말',
  system_prompt         TEXT NULL COMMENT '시스템 프롬프트',

  -- ── 답변 범위 ──
  visibility            ENUM('public','internal') NOT NULL DEFAULT 'public'
        COMMENT 'public=공개 자료만 internal=비공개 포함(상담사 보조)',
  unknown_policy        ENUM('strict','normal','lenient') NOT NULL DEFAULT 'strict'
        COMMENT '"모르면 모른다" 강도',
  escalation_threshold  DECIMAL(3,2) NOT NULL DEFAULT 0.50
        COMMENT '0~1. 이 신뢰도 미만이면 상담사 에스컬레이션',
  refusal_topics        LONGTEXT NULL
        COMMENT '답변 금지 주제 배열 JSON 직렬화. NULL=미지정 "[]"=빈배열',
  topics                LONGTEXT NULL
        COMMENT '자유 토픽 태그 배열 JSON 직렬화. NULL=미지정 "[]"=빈배열',

  -- ── 소스 플래그 (자료셋 다대다 hp_bot_source 는 연기 — BOTS-PLAN §1 YAGNI) ──
  use_standard_answers  TINYINT(1) NOT NULL DEFAULT 1
        COMMENT '표준답변 사용 여부 1/0',
  standard_answer_scope ENUM('all','service') NOT NULL DEFAULT 'all'
        COMMENT 'all=전사 공통+서비스, service=이 봇의 서비스만',

  -- ── 모델 파라미터 ──
  model                 VARCHAR(60) NOT NULL DEFAULT 'openai/gpt-4.1-mini'
        COMMENT 'LLM 모델 식별자 (AI Gateway 경유)',
  temperature           DECIMAL(3,2) NOT NULL DEFAULT 0.30 COMMENT '0~2',
  max_tokens            INT NOT NULL DEFAULT 2048 COMMENT '응답 최대 토큰',

  -- ── 소프트삭제 / 타임스탬프 (002·003 컨벤션) ──
  status                TINYINT NOT NULL DEFAULT 1 COMMENT '1=active, -1=deleted (soft delete)',
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_service (service_id),
  KEY idx_list (status, service_id, bot_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='서비스별 챗봇(봇) 페르소나·답변범위·모델 설정';

-- ============================================================
-- 시드 — hp_service 7서비스 슬러그(ott/general/global/public/maintenance/refund/standalone)
--   에 맞춘 봇 2개 + 공통봇(service_id NULL) 1개. service_id 는 슬러그 서브쿼리로 해석.
--   ⚠ 슬러그 정본화 (2026-06-18, PMS-INQUIRY-HARVEST §4-2 · 005 재시드 정합):
--     002 옛 슬러그(lms-general/lms-public-security)는 005 에서 7서비스(general/public)로 재매핑됐다.
--     본 시드는 재실행 시 봇 누락을 막기 위해 새 슬러그('general'/'public')를 참조한다.
--     (use-bots.ts SEED_BOTS 의 lms-refund/lms-public/lms-security/lms-hybrid 도 사용하지 않는다.)
--   멱등: name 으로 ON DUPLICATE 보정 불가(UNIQUE 없음)하므로, 재실행 시 중복 방지를 위해
--   '존재하지 않을 때만 INSERT' 하도록 NOT EXISTS 가드를 둔다.
-- ============================================================

-- 1) 공통봇 (service_id = NULL) — 전 서비스 1차 응대
INSERT INTO hp_bot
  (service_id, name, avatar, description, bot_status, tone, traits, greeting, system_prompt,
   visibility, unknown_policy, escalation_threshold, refusal_topics, topics,
   use_standard_answers, standard_answer_scope, model, temperature, max_tokens)
SELECT
  NULL, '공통 상담봇', '🤖',
  '모든 솔루션 공통 문의를 1차 응대하는 기본 봇.', 'active',
  'friendly', '["공감적","단계별 안내","꼼꼼함"]',
  '안녕하세요! 맑은도우미입니다. 무엇을 도와드릴까요?',
  '당신은 맑은소프트 솔루션 전문 고객상담 AI입니다. 제공된 문서와 표준답변만 근거로 답변하고, 확인되지 않은 정보는 "모름"으로 처리하세요. 답변에는 항상 출처를 함께 제시합니다. 항상 한국어로 응답합니다.',
  'public', 'strict', 0.50, '["환불 금액 확정","계약 조건 변경"]', '["로그인","수강신청","결제","진도"]',
  1, 'all', 'openai/gpt-4.1-mini', 0.30, 2048
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM hp_bot WHERE name = '공통 상담봇' AND service_id IS NULL AND status = 1);

-- 2) 범용 LMS 일반봇 (service_id = hp_service 'general')
INSERT INTO hp_bot
  (service_id, name, avatar, description, bot_status, tone, traits, greeting, system_prompt,
   visibility, unknown_policy, escalation_threshold, refusal_topics, topics,
   use_standard_answers, standard_answer_scope, model, temperature, max_tokens)
SELECT
  (SELECT id FROM hp_service WHERE slug = 'general' AND status = 1 LIMIT 1),
  'LMS 일반 상담봇', '📘',
  '범용 LMS 사용법 전반을 안내하는 서비스 전용 봇.', 'active',
  'friendly', '["공감적","단계별 안내","신속함"]',
  '안녕하세요! LMS 사용을 도와드리는 상담봇입니다.',
  '당신은 맑은소프트 범용 LMS 전문 고객상담 AI입니다. 제공된 문서와 표준답변만 근거로 답변하고, 단계가 있는 안내는 번호로 나눠 설명하세요. 확인되지 않은 정보는 "모름"으로 처리합니다. 항상 한국어로 응답합니다.',
  'public', 'strict', 0.50, '["환불 금액 확정"]', '["로그인","수강신청","진도","과제"]',
  1, 'all', 'openai/gpt-4.1-mini', 0.30, 2048
FROM DUAL
WHERE EXISTS (SELECT 1 FROM hp_service WHERE slug = 'general' AND status = 1)
  AND NOT EXISTS (
    SELECT 1 FROM hp_bot
     WHERE name = 'LMS 일반 상담봇'
       AND service_id = (SELECT id FROM hp_service WHERE slug = 'general' AND status = 1 LIMIT 1)
       AND status = 1
  );

-- 3) 공공 보안 전용봇 (service_id = hp_service 'public')
INSERT INTO hp_bot
  (service_id, name, avatar, description, bot_status, tone, traits, greeting, system_prompt,
   visibility, unknown_policy, escalation_threshold, refusal_topics, topics,
   use_standard_answers, standard_answer_scope, model, temperature, max_tokens)
SELECT
  (SELECT id FROM hp_service WHERE slug = 'public' AND status = 1 LIMIT 1),
  '공공 보안 전용봇', '🏛️',
  '공공기관 보안 과정 대상 격식체 봇. 보안·개인정보 안내를 신중히 처리.', 'draft',
  'formal', '["공식적","차분함","보수적(추측 자제)"]',
  '안녕하십니까. 공공 보안 과정 전용 상담 도우미입니다.',
  '당신은 공공기관 보안 과정 고객사를 응대하는 격식 있는 상담 AI입니다. 공문 톤을 유지하고, 보안·개인정보 관련 안내는 특히 신중하게 처리합니다. 근거가 없으면 즉시 상담사에게 연결하세요.',
  'internal', 'normal', 0.60, '["내부 시스템 구조 노출","개인정보 조회"]', '["보안 인증","접근 권한","감사 로그"]',
  1, 'service', 'openai/gpt-4.1-mini', 0.20, 2048
FROM DUAL
WHERE EXISTS (SELECT 1 FROM hp_service WHERE slug = 'public' AND status = 1)
  AND NOT EXISTS (
    SELECT 1 FROM hp_bot
     WHERE name = '공공 보안 전용봇'
       AND service_id = (SELECT id FROM hp_service WHERE slug = 'public' AND status = 1 LIMIT 1)
       AND status = 1
  );
