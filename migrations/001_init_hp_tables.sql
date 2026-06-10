-- migrations/001_init_hp_tables.sql
-- Malgn Helper — 초기 hp_* 테이블 생성
-- 실행 위치: PMS DB (Hyperdrive 통해 연결 중인 동일 MySQL)
-- 설계 문서: malgn-helper/docs/HP-SCHEMA.md
-- 안전성: 모두 CREATE TABLE IF NOT EXISTS. tb_* 운영 테이블은 건드리지 않음.

-- ── 1. 프로젝트 브리핑 카드 캐시 ─────────────────────────
CREATE TABLE IF NOT EXISTS hp_briefing (
  id                INT NOT NULL AUTO_INCREMENT,
  project_id        INT NOT NULL,
  generated_at      DATETIME NOT NULL,
  generator         VARCHAR(20) NOT NULL COMMENT 'db_only|llm|hybrid',
  llm_model         VARCHAR(50) NULL,
  llm_input_hash    CHAR(64) NULL COMMENT 'input SHA-256, 캐시 키',
  prompt_tokens     INT NULL,
  completion_tokens INT NULL,
  latency_ms        INT NULL,
  briefing_json     LONGTEXT NOT NULL,
  status            TINYINT NOT NULL DEFAULT 1 COMMENT '1=active, -1=deleted',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_project_status_gen (project_id, status, generated_at),
  KEY idx_input_hash (llm_input_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='프로젝트 브리핑 카드 캐시 (LLM 결과)';

-- ── 2. 게시글 Q&A 평가 카드 캐시 ─────────────────────────
CREATE TABLE IF NOT EXISTS hp_qa_eval (
  id                INT NOT NULL AUTO_INCREMENT,
  post_id           INT NOT NULL,
  project_id        INT NOT NULL,
  generated_at      DATETIME NOT NULL,
  generator         VARCHAR(20) NOT NULL,
  llm_model         VARCHAR(50) NULL,
  llm_input_hash    CHAR(64) NULL,
  prompt_tokens     INT NULL,
  completion_tokens INT NULL,
  latency_ms        INT NULL,
  eval_json         LONGTEXT NOT NULL,
  overall_score     DECIMAL(3,2) NULL COMMENT '정렬·필터용',
  overall_verdict   VARCHAR(20) NULL,
  status            TINYINT NOT NULL DEFAULT 1,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_post_status_gen (post_id, status, generated_at),
  KEY idx_project_score (project_id, overall_score),
  KEY idx_input_hash (llm_input_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='게시글 Q&A 평가 카드 캐시 (LLM 결과)';

-- ── 3. 표준 답변 카탈로그 ─────────────────────────────────
CREATE TABLE IF NOT EXISTS hp_standard_answer (
  id              INT NOT NULL AUTO_INCREMENT,
  label           VARCHAR(100) NOT NULL,
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  project_id      INT NULL COMMENT 'NULL=전사 공통',
  source_post_id  INT NULL,
  source_axis     VARCHAR(10) NULL COMMENT 'QaEval A~E',
  created_by      VARCHAR(100) NULL COMMENT '저장한 직원 이메일 (인증 도입 후)',
  usage_count     INT NOT NULL DEFAULT 0,
  last_used_at    DATETIME NULL,
  status          TINYINT NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_project_status (project_id, status),
  KEY idx_usage (status, usage_count),
  KEY idx_source_post (source_post_id),
  FULLTEXT KEY idx_qa (question, answer)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='표준 답변 카탈로그 (챗봇 1순위 응답 소스)';

-- ── 4. LLM 호출 감사 로그 ────────────────────────────────
CREATE TABLE IF NOT EXISTS hp_llm_log (
  id                BIGINT NOT NULL AUTO_INCREMENT,
  route             VARCHAR(100) NOT NULL,
  entity_type       VARCHAR(30) NOT NULL COMMENT 'briefing|qa_eval|chat 등',
  entity_id         INT NULL,
  model             VARCHAR(50) NOT NULL,
  prompt_tokens     INT NULL,
  completion_tokens INT NULL,
  latency_ms        INT NULL,
  cost_usd          DECIMAL(10,6) NULL,
  cache_hit         TINYINT NOT NULL DEFAULT 0,
  error             TEXT NULL,
  request_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_entity (entity_type, entity_id, request_at),
  KEY idx_request_at (request_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='LLM 호출 감사 로그 (비용·지연·실패 추적)';
