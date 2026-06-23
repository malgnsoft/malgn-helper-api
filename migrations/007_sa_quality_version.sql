-- migrations/007_sa_quality_version.sql
-- Malgn Helper — 표준답변/안내글 버전·최신성 관리 컬럼·인덱스 추가
--   hp_standard_answer · hp_announce 두 테이블에
--   버전 체인(supersedes_id · superseded_by_id) · archive 사유(archived_reason) ·
--   최신성 재검증 기준일(last_verified_at) 추가.
-- 실행 위치: 운영 PMS DB (실서버 221.143.42.213, MySQL 5.6.51-log, DB `pms`)
-- 설계 정본:
--   malgn-helper-mng/docs/STANDARD-ANSWER-QUALITY.md §10-2 (dba 스키마 보강 요청)
--   §4 (approved→archived 전이 규칙) · §6-3 (의미 변경 new row 처리) · §2-⑦ (최신성 180일)
-- 직전 마이그레이션:
--   006_pii_gate.sql (hp_standard_answer · hp_announce PII 게이트 컬럼·인덱스)
-- 컨벤션(003~006 동일): utf8mb4 / status TINYINT(1=active,-1=deleted) / DATETIME / ENUM(5.6 지원)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ MySQL 5.6.51 제약 (적용 전 반드시 숙지)
-- ─────────────────────────────────────────────────────────────────────────────
--  1) `ADD COLUMN IF NOT EXISTS` / `ADD INDEX IF NOT EXISTS` 미지원(MySQL 8.0.29+).
--     → 본 파일의 ALTER 는 멱등하지 않다(재실행 시 "Duplicate column/key name" 에러).
--       적용 엔드포인트(일회용 라우트)가 information_schema 로 컬럼·인덱스 부재를
--       테이블별로 확인한 뒤 1회만 실행한다(006 선례 동일 방식).
--     → 아래 [적용 전 점검] 쿼리를 먼저 실행해 부재를 확인한다.
--  2) CHECK 제약·생성 컬럼(GENERATED ALWAYS AS) 5.6 미지원 → 사용하지 않는다.
--     supersedes_id/superseded_by_id 는 INT NULL FK 없이 앱이 참조 정합성을 검증한다.
--  3) ENUM 은 5.6 지원. archived_reason ENUM('superseded','outdated','domain_closed') 사용.
--  4) online DDL: ADD COLUMN/ADD KEY 는 소규모 테이블에서 5.6 INPLACE 가능.
--     트래픽 한가한 시간대 적용 권장.
--  5) FK 미사용: supersedes_id/superseded_by_id 는 같은 테이블 내 id 를 가리키지만
--     DB FK 제약은 걸지 않는다(HP-SCHEMA §1 원칙 + 003/006 동일). 정합성은 앱이 검증.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ 적용 방식 — 006 선례와 동일 (일회용 엔드포인트)
-- ─────────────────────────────────────────────────────────────────────────────
--   003/005/006 선례: 일회용 라우트 → 배포 → 실행 → 제거 → 재배포(404).
--   본 파일의 ALTER 는 적용 로직의 정본 레퍼런스이며,
--   실제 적용은 엔드포인트가 information_schema 점검 후 분기 실행한다.
--   DBA 는 적용하지 않는다(설계·정합만).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ 기존 데이터 영향 / backfill
-- ─────────────────────────────────────────────────────────────────────────────
--   - last_verified_at    : DEFAULT NULL → 기존 행 전부 NULL(미검증 상태).
--     챗봇·admin 이 "needsVerification(last_verified_at < NOW()-180d OR last_verified_at IS NULL)"
--     필터로 노출하면 기존 모든 approved 행이 재검증 대기로 분류된다.
--     운영자는 초기 일괄 설정이 필요하다면 아래 [선택: backfill] 참조.
--   - archived_reason     : DEFAULT NULL → 기존 archived 행도 NULL. archive 사유가 없던 구형 데이터.
--     필요 시 수동으로 사유를 채우면 되며, NULL 허용이라 운영상 문제 없음.
--   - supersedes_id / superseded_by_id : DEFAULT NULL → 기존 행 전부 NULL(단일 버전).
--     의미 변경 신규본부터 값이 채워진다. backfill 불필요.
--
-- 롤백: 파일 하단 [롤백] 섹션 — 추가 인덱스·컬럼을 역순 DROP. 데이터 손실 주의.
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- [적용 전 점검] — 컬럼·인덱스 부재 확인. 있으면 해당 ALTER 생략. 적용 엔드포인트가 자동 수행.
-- ─────────────────────────────────────────────────────────────────────────────
--   SELECT TABLE_NAME, COLUMN_NAME
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME   IN ('hp_standard_answer','hp_announce')
--      AND COLUMN_NAME  IN ('last_verified_at','archived_reason',
--                           'supersedes_id','superseded_by_id');
--
--   SELECT TABLE_NAME, INDEX_NAME
--     FROM information_schema.STATISTICS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME   IN ('hp_standard_answer','hp_announce')
--      AND INDEX_NAME   IN ('idx_needs_verification','idx_superseded_by');


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 1. hp_standard_answer — 버전·최신성 컬럼                                     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE hp_standard_answer
  ADD COLUMN last_verified_at DATETIME NULL
      COMMENT '최신성 재검증 기준일(QUALITY §2-⑦ F1). approved 전이 시 NOW()로 초기화, 재검증 확인 시 갱신. NULL=미검증. 180일 초과 시 needsVerification 큐 대상.'
      AFTER approved_at,
  ADD COLUMN archived_reason ENUM('superseded','outdated','domain_closed') NULL
      COMMENT 'approved→archived 전이 사유(QUALITY §4). superseded=신규본으로 대체, outdated=180일 재검증 실패/노후, domain_closed=제품 도메인 폐기. archive 전이 시 필수 기록.'
      AFTER last_verified_at,
  ADD COLUMN supersedes_id INT NULL
      COMMENT '의미 변경 신규본 → 구본 링크(QUALITY §6-3). 이 row가 대체하는 구 버전 hp_standard_answer.id. 신규 row INSERT 시 기록. (FK 없음, 앱 검증)'
      AFTER archived_reason,
  ADD COLUMN superseded_by_id INT NULL
      COMMENT '구본 → 신규본 링크(QUALITY §6-3). 이 row를 대체한 신 버전 hp_standard_answer.id. 구 row archive 시 기록. CURATION merged_into_id(중복병합)와 별개.'
      AFTER supersedes_id;

-- ── 인덱스 ──
-- needsVerification 조회용: approval_status='approved' AND last_verified_at < threshold
ALTER TABLE hp_standard_answer
  ADD KEY idx_needs_verification (approval_status, last_verified_at);

-- superseded_by_id 단일 인덱스: 버전 체인 역방향 조회 (구본에서 신본 찾기)
ALTER TABLE hp_standard_answer
  ADD KEY idx_superseded_by (superseded_by_id);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 2. hp_announce — 버전·최신성 컬럼 (1구획과 동형)                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE hp_announce
  ADD COLUMN last_verified_at DATETIME NULL
      COMMENT '최신성 재검증 기준일(QUALITY §2-⑦ F1). approved 전이 시 NOW()로 초기화, 재검증 확인 시 갱신. NULL=미검증. 180일 초과 시 needsVerification 큐 대상.'
      AFTER approved_at,
  ADD COLUMN archived_reason ENUM('superseded','outdated','domain_closed') NULL
      COMMENT 'approved→archived 전이 사유(QUALITY §4). superseded=신규본으로 대체, outdated=180일 재검증 실패/노후, domain_closed=제품 도메인 폐기. archive 전이 시 필수 기록.'
      AFTER last_verified_at,
  ADD COLUMN supersedes_id INT NULL
      COMMENT '의미 변경 신규본 → 구본 링크(QUALITY §6-3). 이 row가 대체하는 구 버전 hp_announce.id. 신규 row INSERT 시 기록. (FK 없음, 앱 검증)'
      AFTER archived_reason,
  ADD COLUMN superseded_by_id INT NULL
      COMMENT '구본 → 신규본 링크(QUALITY §6-3). 이 row를 대체한 신 버전 hp_announce.id. 구 row archive 시 기록. CURATION merged_into_id(중복병합)와 별개.'
      AFTER supersedes_id;

-- ── 인덱스 ──
ALTER TABLE hp_announce
  ADD KEY idx_needs_verification (approval_status, last_verified_at);

ALTER TABLE hp_announce
  ADD KEY idx_superseded_by (superseded_by_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- [후속 — 미포함 항목: qa_eval_b/c/d/e]
-- ─────────────────────────────────────────────────────────────────────────────
--   QUALITY §10-2 표의 qa_eval_b(B축 정확성) · qa_eval_c(C축 명확성) ·
--   qa_eval_d(D축 표준화) · qa_eval_e(E축 친절도) 컬럼은 이번 마이그레이션에서 제외.
--   도입 시기 미정(§12 후속 항목 — dba + 기획 추가 합의 후 008+ 마이그레이션에서 추가).
--   추가 시 TINYINT(1) NULL COMMENT '1~5점, NULL=미평가' 패턴으로 각 축별 컬럼 추가 예정.


-- ─────────────────────────────────────────────────────────────────────────────
-- [선택: backfill] — 운영자(도메인 오너) 판단 후 필요 시 주석 해제하여 1회 실행.
-- ─────────────────────────────────────────────────────────────────────────────
--   기존 approved 행을 "현재 시점에 검증된 것"으로 간주해 last_verified_at 를 초기화하려면:
--
--   UPDATE hp_standard_answer
--      SET last_verified_at = NOW()
--    WHERE status = 1
--      AND approval_status = 'approved'
--      AND last_verified_at IS NULL;
--
--   UPDATE hp_announce
--      SET last_verified_at = NOW()
--    WHERE status = 1
--      AND approval_status = 'approved'
--      AND last_verified_at IS NULL;
--
--   ⚠ 실행 전 대상 건수 확인:
--       SELECT COUNT(*) FROM hp_standard_answer WHERE status=1 AND approval_status='approved' AND last_verified_at IS NULL;
--       SELECT COUNT(*) FROM hp_announce        WHERE status=1 AND approval_status='approved' AND last_verified_at IS NULL;
--   ⚠ 초기화를 생략하면 기존 approved 행 전체가 needsVerification 필터에 즉시 포함되어
--      admin 배지·API 응답의 재검증 건수가 크게 증가한다. 운영 맥락에 따라 판단한다.


-- ─────────────────────────────────────────────────────────────────────────────
-- [적용 후 확인]
--   SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME   IN ('hp_standard_answer','hp_announce')
--      AND COLUMN_NAME  IN ('last_verified_at','archived_reason',
--                           'supersedes_id','superseded_by_id')
--    ORDER BY TABLE_NAME, ORDINAL_POSITION;
--
--   SHOW INDEX FROM hp_standard_answer WHERE Key_name IN ('idx_needs_verification','idx_superseded_by');
--   SHOW INDEX FROM hp_announce        WHERE Key_name IN ('idx_needs_verification','idx_superseded_by');
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- [롤백] — 추가한 인덱스·컬럼을 역순 DROP. 데이터 손실 주의(버전 체인·검증 이력 사라짐).
-- ═════════════════════════════════════════════════════════════════════════════
--  -- hp_standard_answer
--  ALTER TABLE hp_standard_answer DROP KEY idx_superseded_by;
--  ALTER TABLE hp_standard_answer DROP KEY idx_needs_verification;
--  ALTER TABLE hp_standard_answer
--    DROP COLUMN superseded_by_id,
--    DROP COLUMN supersedes_id,
--    DROP COLUMN archived_reason,
--    DROP COLUMN last_verified_at;
--
--  -- hp_announce
--  ALTER TABLE hp_announce DROP KEY idx_superseded_by;
--  ALTER TABLE hp_announce DROP KEY idx_needs_verification;
--  ALTER TABLE hp_announce
--    DROP COLUMN superseded_by_id,
--    DROP COLUMN supersedes_id,
--    DROP COLUMN archived_reason,
--    DROP COLUMN last_verified_at;
-- ═════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════
-- [적용 명령 예시] — 운영자가 일회용 엔드포인트 대신 직접 실행할 경우 참고.
--   ⚠ 반드시 [적용 전 점검] 쿼리로 컬럼/인덱스 부재를 확인한 뒤 실행한다.
--   ⚠ 적용 대상 DB: 221.143.42.213 (MySQL 5.6.51), DB pms
--
--   mysql -h 221.143.42.213 -u <USER> -p pms < migrations/007_sa_quality_version.sql
--
--   또는 세션 접속 후:
--   USE pms;
--   SOURCE /path/to/migrations/007_sa_quality_version.sql;
-- ═════════════════════════════════════════════════════════════════════════════
