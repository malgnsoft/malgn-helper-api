-- migrations/006_pii_gate.sql  (privacy 설계 ENUM 통합본 — v2)
-- Malgn Helper — 표준답변/안내글 승인 "PII 게이트" 스키마
--   hp_standard_answer · hp_announce 두 테이블에 개인식별정보(PII) 검수 상태 컬럼·인덱스 추가
--   + hp_setting(safety).pii_patterns 보강 시드(사업자번호·계좌·카드)
-- 실행 위치: 운영 PMS DB (실서버 221.143.42.213, MySQL 5.6.51-log, DB `pms`)
-- 설계 정본: malgn-helper-mng/docs/HP-SCHEMA.md (PII 게이트 절)
-- 직전 마이그레이션:
--   - 003_standard_answer_curation.sql (hp_standard_answer 분류·승인 컬럼 — approval_status 기준)
--   - 005_announce_and_service_reseed.sql (hp_announce 신설 — body/approval_status/status 구조)
-- 컨벤션(002~005 동일): utf8mb4 / status TINYINT(1=active,-1=deleted) / DATETIME / ENUM(5.6 지원).
--
-- ⚙ v2 정합(privacy 설계 ENUM 채택 — 기존 v1 대비 변경):
--   pii_text_status  ENUM('pending','clear','masked','blocked')                            NOT NULL DEFAULT 'pending'
--   image_pii_status ENUM('none','pending','suspect','clear','removed','masked','blocked') NOT NULL DEFAULT 'none'
--   private_source_flag TINYINT NOT NULL DEFAULT 0  (비공개 출처 경고 — 차단 아님)
--   pii_checked_by VARCHAR(100) NULL / pii_checked_at DATETIME NULL  (사람 검수 기록)
--   INDEX idx_pii_gate (image_pii_status, approval_status, status)
--   backfill: 본문(answer/body)에 '<img' 있는 활성 행 → image_pii_status='pending', 없으면 'none';
--             텍스트(pii_text_status)는 전부 'pending'(컬럼 DEFAULT 그대로).
--
-- ⚠⚠⚠ 적용은 api 담당(../malgn-helper-api)이 일회용 엔드포인트로 수행 ⚠⚠⚠
--   003/005/curate 선례: 일회용 라우트 → 배포 → 실행 → 제거 → 재배포(404).
--   본 파일의 ALTER 는 적용 로직의 정본 레퍼런스이며, 실제 적용은 엔드포인트가 information_schema 점검 후 분기 실행한다.
--   DBA는 적용하지 않는다(설계·정합만). PII 값 자체는 로그·응답에 절대 출력 금지(유형·영역·건수만).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⛔ tb_* 무수정 보증
-- ─────────────────────────────────────────────────────────────────────────────
--   PMS 원본 tb_* 테이블은 본 마이그레이션에서 **일절 수정하지 않는다(SELECT 전용)**.
--   DDL 대상은 hp_standard_answer · hp_announce(hp_*)뿐이며, 시드는 hp_setting(hp_*)뿐이다.
--   tb_* 를 가리키는 컬럼(source_post_id 등)은 기존 정의 그대로 두며 FK/변경 없음.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ MySQL 5.6.51 제약 (적용 전 반드시 숙지)
-- ─────────────────────────────────────────────────────────────────────────────
--  1) JSON 타입·표현식 DEFAULT 미지원 → pii_patterns 는 기존 hp_setting 형식(LONGTEXT/MEDIUMTEXT에
--     JSON 직렬화 문자열, value_type='json')을 그대로 따른다. ENUM 은 5.6 지원.
--  2) `ADD COLUMN IF NOT EXISTS` / `ADD INDEX IF NOT EXISTS` 미지원(8.0.29+).
--     → 본 파일 ALTER 는 멱등하지 않다. 적용 엔드포인트가 information_schema 로 컬럼·인덱스
--        부재를 테이블별로 확인한 뒤 1회만 실행한다(부분 적용 안전).
--  3) FK 미사용: pii_checked_by 등은 직원 이메일 문자열만 저장. 정합성은 앱이 검증.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ 기존 데이터 영향 / backfill
-- ─────────────────────────────────────────────────────────────────────────────
--  - pii_text_status DEFAULT 'pending' : 기존 행 전부 "텍스트 미스캔(pending)" → 승인 게이트가 스캔 유도.
--  - image_pii_status DEFAULT 'none'   : 기본은 "이미지 없음". 단 answer/body 에 '<img' 가 있는 행은
--    실제 이미지를 보유하므로 backfill 로 'pending' 보정(아래 [backfill] UPDATE).
--  - private_source_flag DEFAULT 0     : 비공개 출처 경고 플래그. 승인 스캔 시 산정·세팅.
--
-- 롤백: 파일 하단 [롤백] 섹션 — 추가 컬럼·인덱스 역순 DROP. 데이터 손실 주의.
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- [적용 전 점검] — 컬럼·인덱스 부재 확인(있으면 해당 ALTER 생략). 적용 엔드포인트가 자동 수행.
-- ─────────────────────────────────────────────────────────────────────────────
--   SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME   IN ('hp_standard_answer','hp_announce')
--      AND COLUMN_NAME  IN ('pii_text_status','image_pii_status','private_source_flag',
--                           'pii_checked_by','pii_checked_at');
--   SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME   IN ('hp_standard_answer','hp_announce')
--      AND INDEX_NAME   = 'idx_pii_gate';


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 1. hp_standard_answer — PII 게이트 컬럼·인덱스                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
ALTER TABLE hp_standard_answer
  ADD COLUMN pii_text_status ENUM('pending','clear','masked','blocked') NOT NULL DEFAULT 'pending'
      COMMENT '텍스트 자동 스캔 결과. pending=미스캔, clear=고유식별정보 없음, masked=마스킹처리, blocked=발견(승인 차단)'
      AFTER last_used_at,
  ADD COLUMN image_pii_status ENUM('none','pending','suspect','clear','removed','masked','blocked') NOT NULL DEFAULT 'none'
      COMMENT '이미지 PII 검수 상태. none=이미지없음, pending=미검수, suspect=Vision의심, clear=사람검수통과, removed=제거, masked=마스킹, blocked=차단'
      AFTER pii_text_status,
  ADD COLUMN private_source_flag TINYINT NOT NULL DEFAULT 0
      COMMENT '비공개 출처 경고(1=원글 답변이 비공개 출처). 차단 아님 — 검수 주의 신호'
      AFTER image_pii_status,
  ADD COLUMN pii_checked_by VARCHAR(100) NULL
      COMMENT '사람 검수자 직원 이메일 (이미지/최종 게이트 통과 처리자)'
      AFTER private_source_flag,
  ADD COLUMN pii_checked_at DATETIME NULL
      COMMENT '사람 검수 시각'
      AFTER pii_checked_by;

ALTER TABLE hp_standard_answer
  ADD KEY idx_pii_gate (image_pii_status, approval_status, status);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 2. hp_announce — PII 게이트 컬럼·인덱스 (1구획과 동형)                       ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
ALTER TABLE hp_announce
  ADD COLUMN pii_text_status ENUM('pending','clear','masked','blocked') NOT NULL DEFAULT 'pending'
      COMMENT '텍스트 자동 스캔 결과. pending=미스캔, clear=고유식별정보 없음, masked=마스킹처리, blocked=발견(승인 차단)'
      AFTER last_used_at,
  ADD COLUMN image_pii_status ENUM('none','pending','suspect','clear','removed','masked','blocked') NOT NULL DEFAULT 'none'
      COMMENT '이미지 PII 검수 상태. none=이미지없음, pending=미검수, suspect=Vision의심, clear=사람검수통과, removed=제거, masked=마스킹, blocked=차단'
      AFTER pii_text_status,
  ADD COLUMN private_source_flag TINYINT NOT NULL DEFAULT 0
      COMMENT '비공개 출처 경고(1=원글 답변이 비공개 출처). 차단 아님 — 검수 주의 신호'
      AFTER image_pii_status,
  ADD COLUMN pii_checked_by VARCHAR(100) NULL
      COMMENT '사람 검수자 직원 이메일 (이미지/최종 게이트 통과 처리자)'
      AFTER private_source_flag,
  ADD COLUMN pii_checked_at DATETIME NULL
      COMMENT '사람 검수 시각'
      AFTER pii_checked_by;

ALTER TABLE hp_announce
  ADD KEY idx_pii_gate (image_pii_status, approval_status, status);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 3. hp_setting(safety).pii_patterns 보강 시드                                ║
-- ║    현 시드(002)=주민번호·전화·이메일 → 사업자번호·계좌·카드 정규식 추가      ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--   ⚠ setting_value 를 새 목록으로 덮어쓴다. 적용 전 현재 값을 백업하라:
--       SELECT setting_value FROM hp_setting WHERE group_name='safety' AND setting_key='pii_patterns';
--   정규식 목록(기존 3 + 신규 3, 002 이스케이프 형식: SQL 리터럴 \\\\d → 저장값 \\d → 정규식 \d):
--     [기존] 주민등록번호 : \d{6}-[1-4]\d{6}
--     [기존] 전화번호     : \d{3}-\d{3,4}-\d{4}
--     [기존] 이메일       : [a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}
--     [신규] 사업자등록번호: \d{3}-\d{2}-\d{5}
--     [신규] 계좌번호(범용): \d{2,6}-\d{2,6}-\d{2,7}   (은행별 자릿수 편차 흡수 — 광범위, 오탐 가능)
--     [신규] 카드번호(16) : (?:\d{4}[- ]?){3}\d{4}
INSERT INTO hp_setting (group_name, setting_key, setting_value, value_type) VALUES
  ('safety', 'pii_patterns',
   '["\\\\d{6}-[1-4]\\\\d{6}","\\\\d{3}-\\\\d{3,4}-\\\\d{4}","[a-zA-Z0-9._%+\\\\-]+@[a-zA-Z0-9.\\\\-]+\\\\.[a-zA-Z]{2,}","\\\\d{3}-\\\\d{2}-\\\\d{5}","\\\\d{2,6}-\\\\d{2,6}-\\\\d{2,7}","(?:\\\\d{4}[- ]?){3}\\\\d{4}"]',
   'json')
ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), value_type=VALUES(value_type);


-- ─────────────────────────────────────────────────────────────────────────────
-- [backfill] — 본문에 '<img' 있는 활성 행만 image_pii_status='pending'(미검수)로 보정.
--   '<img' 없는 행은 'none'(컬럼 DEFAULT) 유지. 텍스트는 전부 'pending'(DEFAULT)이라 별도 backfill 불요.
--   ⚠ 멱등: WHERE image_pii_status='none' 로 한정 → 재실행해도 suspect/clear 등은 보존.
--   대상 행 수 확인:
--     SELECT COUNT(*) FROM hp_standard_answer WHERE status=1 AND answer LIKE '%<img%' AND image_pii_status='none';
--     SELECT COUNT(*) FROM hp_announce        WHERE status=1 AND body   LIKE '%<img%' AND image_pii_status='none';
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE hp_standard_answer
   SET image_pii_status = 'pending'
 WHERE status = 1
   AND answer LIKE '%<img%'
   AND image_pii_status = 'none';

UPDATE hp_announce
   SET image_pii_status = 'pending'
 WHERE status = 1
   AND body LIKE '%<img%'
   AND image_pii_status = 'none';


-- ─────────────────────────────────────────────────────────────────────────────
-- [적용 후 확인]
--   SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA=DATABASE()
--      AND TABLE_NAME IN ('hp_standard_answer','hp_announce')
--      AND (COLUMN_NAME LIKE 'pii%' OR COLUMN_NAME IN ('image_pii_status','private_source_flag'));
--   SHOW INDEX FROM hp_standard_answer WHERE Key_name='idx_pii_gate';
--   SHOW INDEX FROM hp_announce        WHERE Key_name='idx_pii_gate';


-- ═════════════════════════════════════════════════════════════════════════════
-- [롤백] — 추가한 인덱스·컬럼을 역순 DROP. 데이터 손실 주의(검수 이력 사라짐).
-- ═════════════════════════════════════════════════════════════════════════════
--  ALTER TABLE hp_standard_answer DROP KEY idx_pii_gate;
--  ALTER TABLE hp_announce        DROP KEY idx_pii_gate;
--  ALTER TABLE hp_standard_answer
--    DROP COLUMN pii_checked_at, DROP COLUMN pii_checked_by,
--    DROP COLUMN private_source_flag, DROP COLUMN image_pii_status, DROP COLUMN pii_text_status;
--  ALTER TABLE hp_announce
--    DROP COLUMN pii_checked_at, DROP COLUMN pii_checked_by,
--    DROP COLUMN private_source_flag, DROP COLUMN image_pii_status, DROP COLUMN pii_text_status;
--  -- pii_patterns 002 3패턴 환원:
--  UPDATE hp_setting
--     SET setting_value = '["\\\\d{6}-[1-4]\\\\d{6}","\\\\d{3}-\\\\d{3,4}-\\\\d{4}","[a-zA-Z0-9._%+\\\\-]+@[a-zA-Z0-9.\\\\-]+\\\\.[a-zA-Z]{2,}"]'
--   WHERE group_name='safety' AND setting_key='pii_patterns';
-- ═════════════════════════════════════════════════════════════════════════════
