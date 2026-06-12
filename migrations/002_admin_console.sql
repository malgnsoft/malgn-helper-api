-- migrations/002_admin_console.sql
-- Malgn Helper — 관리자 콘솔(목업 실데이터화) 백엔드 스키마
-- 실행 위치: PMS DB (Hyperdrive 통해 연결 중인 동일 MySQL 5.6)
-- 설계 문서: malgn-helper-mng/docs/HP-SCHEMA.md, malgn-helper-admin/pages/{catalog,settings/*}.vue
-- 안전성: 모두 CREATE TABLE IF NOT EXISTS + INSERT ... ON DUPLICATE KEY. tb_* 운영 테이블 무영향.
-- 컨벤션: utf8mb4 / status TINYINT(1=active,-1=deleted) / DATETIME / utf8mb4 UNIQUE prefix(191).
--   ※ slug·key 류는 모두 VARCHAR<=191 (ascii) 이므로 prefix 불필요.

-- ── 1. 토픽 카탈로그 (표준답변 분류 / catalog.vue MOCK_TOPICS) ──
--   active = 운영 노출 토글(UI '활성/비활성'), status = soft-delete(행 숨김).
CREATE TABLE IF NOT EXISTS hp_topic (
  id            INT NOT NULL AUTO_INCREMENT,
  slug          VARCHAR(100) NOT NULL COMMENT 'URL/식별 슬러그 (예: login)',
  scope         ENUM('common','service') NOT NULL DEFAULT 'common' COMMENT 'common=전사 공통, service=서비스 특화',
  label         VARCHAR(100) NOT NULL COMMENT '표시 라벨 (예: 로그인/계정)',
  description   VARCHAR(255) NULL COMMENT '설명',
  sort_order    INT NOT NULL DEFAULT 0 COMMENT '정렬값 (오름차순)',
  active        TINYINT NOT NULL DEFAULT 1 COMMENT '운영 노출 토글 1=활성 0=비활성',
  status        TINYINT NOT NULL DEFAULT 1 COMMENT '1=active, -1=deleted (soft delete)',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_scope_slug (scope, slug),
  KEY idx_list (status, scope, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='표준답변 분류용 토픽 카탈로그';

-- ── 2. 서비스(LMS 패밀리) 카탈로그 (catalog.vue MOCK_SERVICES) ──
CREATE TABLE IF NOT EXISTS hp_service (
  id            INT NOT NULL AUTO_INCREMENT,
  slug          VARCHAR(100) NOT NULL COMMENT '식별 슬러그 (예: step)',
  name          VARCHAR(100) NOT NULL COMMENT '서비스명 (예: STEP 온라인)',
  note          VARCHAR(255) NULL COMMENT '비고',
  sort_order    INT NOT NULL DEFAULT 0,
  active        TINYINT NOT NULL DEFAULT 1 COMMENT '운영 노출 토글 1=활성 0=비활성',
  status        TINYINT NOT NULL DEFAULT 1 COMMENT '1=active, -1=deleted',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_slug (slug),
  KEY idx_list (status, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='LMS 서비스 패밀리 카탈로그';

-- ── 3. 설정 key-value (settings/ai·safety·cache.vue 공용 단일 테이블) ──
--   group_name='ai'|'safety'|'cache'. setting_value 는 스칼라 또는 JSON 문자열.
--   value_type 로 파서 분기(string|number|boolean|json). (group/key/value 는 예약어라 접두/접미).
CREATE TABLE IF NOT EXISTS hp_setting (
  id            INT NOT NULL AUTO_INCREMENT,
  group_name    VARCHAR(30) NOT NULL COMMENT 'ai|safety|cache (설정 그룹)',
  setting_key   VARCHAR(60) NOT NULL COMMENT '설정 키 (예: chat_model)',
  setting_value MEDIUMTEXT NULL COMMENT '값(스칼라) 또는 JSON 직렬화 문자열',
  value_type    VARCHAR(10) NOT NULL DEFAULT 'string' COMMENT 'string|number|boolean|json',
  updated_by    VARCHAR(100) NULL COMMENT '마지막 수정 직원 이메일',
  status        TINYINT NOT NULL DEFAULT 1 COMMENT '1=active, -1=deleted',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_group_key (group_name, setting_key),
  KEY idx_group_status (group_name, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='관리자 설정 key-value (ai/safety/cache)';

-- ── 4. 외부 연동 (settings/integrations.vue) ──
--   ⚠ 시크릿(Webhook URL·API Key·Client Secret 등)은 DB 평문 저장 금지.
--     → wrangler secret 에 보관하고, 여기엔 secret_set 플래그 + 비밀 아닌 config_json 만.
--   conn_status = 연결 상태(UI 뱃지), status = soft-delete.
CREATE TABLE IF NOT EXISTS hp_integration (
  id               INT NOT NULL AUTO_INCREMENT,
  integration_key  VARCHAR(40) NOT NULL COMMENT '식별자 (slack|email|freshdesk|jira|saml|r2|ai-gateway|opensearch)',
  name             VARCHAR(60) NOT NULL COMMENT '표시명',
  category         VARCHAR(30) NOT NULL COMMENT '알림|티켓|인증|스토리지|AI',
  description      VARCHAR(255) NULL,
  conn_status      ENUM('connected','disconnected','error') NOT NULL DEFAULT 'disconnected' COMMENT '연결 상태',
  detail           VARCHAR(255) NULL COMMENT '상태 상세 문구 (예: malgn-helper-assets)',
  config_json      MEDIUMTEXT NULL COMMENT '비밀이 아닌 설정 JSON (예: {"channel":"#cs"})',
  secret_set       TINYINT NOT NULL DEFAULT 0 COMMENT '시크릿이 wrangler secret 에 설정됨 1/0',
  docs_url         VARCHAR(255) NULL,
  sort_order       INT NOT NULL DEFAULT 0,
  status           TINYINT NOT NULL DEFAULT 1 COMMENT '1=active, -1=deleted',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_integration_key (integration_key),
  KEY idx_list (status, category, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='외부 연동 설정/상태';

-- ============================================================
-- 시드(선택) — 목업의 기본 카탈로그/설정을 초기값으로. 멱등(ON DUPLICATE KEY).
-- 운영 데이터가 이미 있으면 실행 생략 가능.
-- ============================================================

-- 4-1. 토픽 기본값
INSERT INTO hp_topic (slug, scope, label, description, sort_order) VALUES
  ('login',       'common',  '로그인/계정',   'ID/비밀번호·계정 이슈',  10),
  ('enrollment',  'common',  '수강신청',      '과정 등록·취소',         20),
  ('payment',     'common',  '결제/비용',     '결제·영수증·할인',       30),
  ('refund',      'common',  '환불/취소',     '환불 정책·처리 기간',    40),
  ('certificate', 'common',  '수료증/자격증', '발급·재발급·이수 인정',  50),
  ('content',     'common',  '콘텐츠/학습',   '동영상·자료·진도율',     60),
  ('schedule',    'common',  '일정/기간',     '수강 기간·연장·마감',    70),
  ('technical',   'common',  '시스템 오류',   '접속 장애·재생 오류',    80),
  ('step',        'service', 'STEP 전용',     'STEP LMS 특화 문의',     10),
  ('lms-global',  'service', '글로벌 LMS',    '해외 교육 과정 문의',    20)
ON DUPLICATE KEY UPDATE label=VALUES(label), description=VALUES(description), sort_order=VALUES(sort_order);

-- 4-2. 서비스 기본값
INSERT INTO hp_service (slug, name, note, sort_order) VALUES
  ('step',                'STEP 온라인', 'STEP LMS 범용',     10),
  ('lms-general',         '범용 LMS',    '일반 기업 교육',    20),
  ('lms-mixed',           '혼합 LMS',    '혼합 훈련 과정',    30),
  ('lms-private',         '민간 인증',   '민간 자격 취득 과정', 40),
  ('lms-public-security', '공공 보안',   '공공기관 보안 과정', 50),
  ('lms-global',          '글로벌',      '해외·영문 과정',    60)
ON DUPLICATE KEY UPDATE name=VALUES(name), note=VALUES(note), sort_order=VALUES(sort_order);

-- 4-3. AI 설정 기본값
INSERT INTO hp_setting (group_name, setting_key, setting_value, value_type) VALUES
  ('ai', 'chat_model',     'openai/gpt-4.1-mini', 'string'),
  ('ai', 'vision_model',   'openai/gpt-4.1-mini', 'string'),
  ('ai', 'temperature',    '0.3',                 'number'),
  ('ai', 'max_tokens',     '2048',                'number'),
  ('ai', 'timeout_sec',    '30',                  'number'),
  ('ai', 'cache_ttl_sec',  '86400',               'number'),
  ('ai', 'chat_prompt',    '당신은 맑은소프트 솔루션 전문 고객상담 AI입니다. 제공된 문서와 표준답변만 근거로 답변하고, 확인되지 않은 정보는 "모름"으로 처리하세요. 항상 한국어로 응답합니다.', 'string'),
  ('ai', 'eval_prompt',    '주어진 상담 응답을 5개 축(정확성·완전성·가독성·공감·준수)으로 1-5점 채점하세요.', 'string'),
  ('ai', 'suggest_prompt', '상담사가 고객 문의에 답하기 위한 최적의 표준답변과 참고 자료를 추천하세요.', 'string')
ON DUPLICATE KEY UPDATE setting_value=setting_value;  -- 기존 운영값 보존(초기 1회만 의미)

-- 4-4. 안전가드 설정 기본값
INSERT INTO hp_setting (group_name, setting_key, setting_value, value_type) VALUES
  ('safety', 'confidence_threshold', '0.6',   'number'),
  ('safety', 'escalate_on_low',      'true',  'boolean'),
  ('safety', 'pii_masking',          'true',  'boolean'),
  ('safety', 'pii_patterns',         '["\\\\d{6}-[1-4]\\\\d{6}","\\\\d{3}-\\\\d{3,4}-\\\\d{4}","[a-zA-Z0-9._%+\\\\-]+@[a-zA-Z0-9.\\\\-]+\\\\.[a-zA-Z]{2,}"]', 'json'),
  ('safety', 'blocked_words',        '["비방","욕설","스팸","광고"]', 'json')
ON DUPLICATE KEY UPDATE setting_value=setting_value;

-- 4-5. 캐싱 설정 기본값
INSERT INTO hp_setting (group_name, setting_key, setting_value, value_type) VALUES
  ('cache', 'enabled',                              'true',  'boolean'),
  ('cache', 'ttl_sec',                              '86400', 'number'),
  ('cache', 'max_entries',                          '5000',  'number'),
  ('cache', 'strategy',                             'lru',   'string'),
  ('cache', 'invalidate_on_standard_answer_update', 'true',  'boolean'),
  ('cache', 'invalidate_on_material_update',        'true',  'boolean'),
  ('cache', 'invalidate_on_prompt_update',          'false', 'boolean')
ON DUPLICATE KEY UPDATE setting_value=setting_value;

-- 4-6. 외부 연동 기본 카탈로그
INSERT INTO hp_integration (integration_key, name, category, description, conn_status, detail, docs_url, sort_order) VALUES
  ('slack',      'Slack',                    '알림',     '에스컬레이션·알림을 Slack 채널로 전송합니다.',  'disconnected', '연결 안 됨', 'https://api.slack.com/incoming-webhooks', 10),
  ('email',      '이메일 (SMTP)',            '알림',     '시스템 알림과 리포트를 이메일로 발송합니다.',    'disconnected', '연결 안 됨', NULL, 20),
  ('freshdesk',  'Freshdesk',                '티켓',     '에스컬레이션 발생 시 Freshdesk 티켓을 자동 생성합니다.', 'disconnected', '연결 안 됨', 'https://developers.freshdesk.com/', 30),
  ('jira',       'Jira Service Management',  '티켓',     '이슈 트래킹 및 서비스 데스크 티켓 연동.',        'disconnected', '연결 안 됨', NULL, 40),
  ('saml',       'SAML 2.0 SSO',             '인증',     '기업 IdP(Azure AD·Okta 등)와 SSO 연동.',        'disconnected', '연결 안 됨', NULL, 50),
  ('r2',         'Cloudflare R2',            '스토리지', '업로드 파일·이미지를 R2 버킷에 저장합니다.',    'connected',    'malgn-helper-assets', NULL, 60),
  ('ai-gateway', 'Cloudflare AI Gateway',    'AI',       'LLM 호출 라우팅·캐싱·모니터링 게이트웨이.',     'connected',    'malgn-helper2', 'https://developers.cloudflare.com/ai-gateway/', 70),
  ('opensearch', 'Amazon OpenSearch',        'AI',       'RAG 벡터 검색 인덱스 클러스터.',                'disconnected', '연결 안 됨 — Phase 1 후반 연동 예정', NULL, 80)
ON DUPLICATE KEY UPDATE name=VALUES(name), category=VALUES(category), description=VALUES(description),
  detail=VALUES(detail), docs_url=VALUES(docs_url), sort_order=VALUES(sort_order);
