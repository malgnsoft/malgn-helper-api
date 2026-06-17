-- migrations/003_standard_answer_curation.sql
-- Malgn Helper — 표준답변(hp_standard_answer) 수집·큐레이션 강화 (분류·승인·중복/병합)
-- 실행 위치: 운영 PMS DB (실서버 221.143.42.213, MySQL 5.6.51-log, DB `pms`)
-- 설계 정본: malgn-helper-mng/docs/STANDARD-ANSWER-CURATION.md §9-A (DBA 스키마 요구사항)
--           malgn-helper-mng/docs/HP-SCHEMA.md §3-3 (기존 hp_standard_answer 정의)
-- 직전 마이그레이션: migrations/002_admin_console.sql (hp_topic / hp_service 카탈로그 실체화)
-- 컨벤션: utf8mb4 / status TINYINT(1=active,-1=deleted) / DATETIME / ENUM은 5.6 지원.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ MySQL 5.6.51 제약 (적용 전 반드시 숙지)
-- ─────────────────────────────────────────────────────────────────────────────
--  1) JSON 타입·표현식 DEFAULT( DEFAULT('[]') 등 ) 미지원
--     → `tags` 는 LONGTEXT NULL 로 두고, 애플리케이션이 JSON 직렬화/역직렬화한다.
--        (HP-SCHEMA §1-4 "LLM 결과·JSON 은 LONGTEXT + serialization" 원칙과 동일.)
--        NULL = 미지정, '[]' = 빈 태그배열. NOT NULL DEFAULT 표현식을 못 쓰므로 NULL 허용.
--  2) `ADD COLUMN IF NOT EXISTS` / `ADD INDEX IF NOT EXISTS` 미지원(MySQL 8.0.29+ 기능)
--     → 이 파일은 **멱등하지 않다.** 재실행 시 "Duplicate column/key name" 에러로 중단된다.
--        반드시 아래 [적용 전 점검] 쿼리로 컬럼·인덱스 부재를 확인한 뒤 1회만 실행한다.
--        부분 적용으로 일부 컬럼만 존재하는 상태라면, 존재하는 ADD 절만 수동 제거 후 실행.
--  3) MySQL 5.6 online DDL 한계: ADD COLUMN/ADD INDEX 는 5.6 에서 ALGORITHM=INPLACE 가능하나
--     `LOCK=NONE` 보장이 약하다(특히 다중 ADD 혼합). 현재 hp_standard_answer 는 소규모(약 3행)라
--     테이블 락이 걸려도 영향 미미. 그래도 트래픽 한가한 시간대 적용 권장.
--  4) FK 미사용: topic_id / service_id 는 hp_topic.id / hp_service.id 를 참조하지만
--     DB FK 제약은 걸지 않는다(HP-SCHEMA §1 원칙 + 운영 편의). 정합성은 애플리케이션이 검증.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ 기존 데이터(현재 약 3행) 영향 — backfill 판단 필요
-- ─────────────────────────────────────────────────────────────────────────────
--  - 추가 컬럼은 전부 NULL 허용 또는 DEFAULT 가 있어 ADD COLUMN 자체는 기존 행을 깨지 않는다.
--  - 그러나 approval_status DEFAULT 'draft' 이므로 **기존 행이 모두 draft 로 떨어진다.**
--    챗봇 매칭(FR-1 AC-1.2)은 approval_status='approved' 만 후보로 쓰므로,
--    이미 운영 중이던 표준답변이 draft 가 되면 **응답에서 빠진다.**
--  - 대응: 기존 행을 검토 없이 approved 로 승격할지는 운영자(도메인 오너) 판단.
--    아래 [선택: 기존 행 backfill] UPDATE 를 검토 후 필요 시 1회 실행(기본은 주석 처리).
--  - scope 는 DEFAULT 'service' 로 떨어진다. 기존 행 중 전사 공통 답변(project_id IS NULL)은
--    의미상 'common' 이 맞을 수 있다 → backfill 절에서 함께 보정 제안.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ embedding 컬럼은 이 마이그레이션에서 제외
-- ─────────────────────────────────────────────────────────────────────────────
--  §9-A 표의 `embedding` 은 DB 컬럼이 아니라 **OpenSearch k-NN 색인**으로 분리한다.
--  (text-embedding-3-small 1536d 벡터를 MySQL 5.6 에 두지 않는다 — 검색은 자료 인덱싱
--   파이프라인과 동일하게 OpenSearch가 담당.) 중복 cosine·매칭은 OpenSearch 측에서 수행.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 롤백 DDL (파일 하단 [롤백] 섹션 참조) — 추가한 컬럼·인덱스를 역순 DROP. 데이터 손실 주의.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── 1. 컬럼 추가 (분류 · 승인 · 중복/병합 · 출처) ──
--   §9-A 표 순서대로. 한 ALTER 문에 묶어 단일 테이블 재구성(5.6 에서 다중 ADD 1회 처리).
ALTER TABLE hp_standard_answer
  ADD COLUMN scope ENUM('common','service') NOT NULL DEFAULT 'service'
      COMMENT 'common=전 솔루션 공통, service=특정 서비스 전용 (§2-1)'
      AFTER source_axis,
  ADD COLUMN topic_id INT NULL
      COMMENT 'hp_topic.id (FK 없음, 앱 검증). 주제 분류 (§2-1)'
      AFTER scope,
  ADD COLUMN service_id INT NULL
      COMMENT 'hp_service.id (FK 없음, 앱 검증). scope=service 일 때만 의미 (§2-1)'
      AFTER topic_id,
  ADD COLUMN tags LONGTEXT NULL
      COMMENT '자유 태그 JSON 직렬화 문자열. 5.6 JSON 타입 미지원 → LONGTEXT (NULL=미지정, "[]"=빈배열)'
      AFTER service_id,
  ADD COLUMN approval_status ENUM('draft','reviewing','approved','rejected','archived') NOT NULL DEFAULT 'draft'
      COMMENT '큐레이션 라이프사이클 (§3-2). 챗봇은 approved 만 사용. status(soft-delete)와 분리'
      AFTER tags,
  ADD COLUMN approved_by VARCHAR(100) NULL
      COMMENT '승인/반려 처리 직원 이메일 (§3-4)'
      AFTER approval_status,
  ADD COLUMN approved_at DATETIME NULL
      COMMENT '승인 시각 (§3-4)'
      AFTER approved_by,
  ADD COLUMN rejection_reason VARCHAR(255) NULL
      COMMENT '반려 사유 — 반려 시 필수 (§3-4)'
      AFTER approved_at,
  ADD COLUMN merged_into_id INT NULL
      COMMENT '병합 흡수 시 생존(primary) row id. 흡수 row 는 status=-1 (§4-2)'
      AFTER rejection_reason,
  ADD COLUMN source_uncovered_id INT NULL
      COMMENT 'hp_uncovered_question.id — 미커버 질문→후보 전환 출처 (§5-1, Phase 2)'
      AFTER merged_into_id;

-- ── 2. 인덱스 추가 (§9-A) ──
--   기존 인덱스(idx_project_status / idx_usage / idx_source_post / FULLTEXT idx_qa)는 유지.
ALTER TABLE hp_standard_answer
  ADD KEY idx_approval (approval_status, status),
      -- 승인 대기 큐 깊이(approval_status IN draft,reviewing) · 챗봇 approved 필터 (§6 KPI, FR-1)
  ADD KEY idx_scope_topic (scope, topic_id, service_id, status),
      -- 분류 매칭(§2-3): scope→topic→service 순 선택도. status 로 활성행만.
  ADD KEY idx_merged (merged_into_id);
      -- 병합 역추적(§4-2): 특정 primary 로 흡수된 secondary 들 조회.

-- ─────────────────────────────────────────────────────────────────────────────
-- [선택: 기존 행 backfill] — 운영자(도메인 오너) 판단 후 필요 시 주석 해제하여 1회 실행.
-- 기본은 주석 처리(자동 승격은 무검증 답변 노출 위험 — 검토 후 결정).
-- ─────────────────────────────────────────────────────────────────────────────
--
-- (a) 기존 활성 행을 검토완료로 간주해 챗봇에 다시 노출하려면(권고: 내용 확인 후):
--     UPDATE hp_standard_answer
--        SET approval_status = 'approved',
--            approved_by     = 'system-backfill',          -- 또는 실제 승인자 이메일
--            approved_at     = NOW()
--      WHERE status = 1
--        AND approval_status = 'draft';                    -- 마이그레이션 직후 일괄
--
-- (b) 전사 공통 답변(project_id IS NULL)을 scope='common' 으로 보정하려면:
--     UPDATE hp_standard_answer
--        SET scope = 'common'
--      WHERE status = 1
--        AND project_id IS NULL;
--
-- ※ (a)(b) 는 멱등하지 않을 수 있으니 WHERE 조건으로 대상 한정 후 실행. 실행 전 행 수 확인:
--     SELECT id, label, project_id, status FROM hp_standard_answer;
-- ═════════════════════════════════════════════════════════════════════════════
