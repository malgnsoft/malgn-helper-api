-- migrations/008_material.sql
-- Malgn Helper — 학습 자료 테이블 hp_material 신설
--   챗봇 지식 소스(파일/URL/텍스트/Q&A)를 등록·색인·검색하기 위한 카탈로그 테이블.
--   file 타입은 R2 오브젝트로 원본 보관(r2_key), 본문은 extracted_text 에 추출·저장(LIKE 검색 MVP).
-- 실행 위치: 운영 PMS DB (실서버 221.143.42.213, MySQL 5.6.51-log, DB `pms`)
-- 설계 정본: malgn-helper-mng/docs/HP-SCHEMA.md (학습 자료 절)
-- 직전 마이그레이션:
--   007_sa_quality_version.sql (hp_standard_answer · hp_announce 버전·최신성 컬럼)
-- 컨벤션(001~007 동일): utf8mb4 / status TINYINT(1=active,-1=deleted, soft) / DATETIME / ENUM(5.6 지원) / FK 미사용(앱 검증)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ MySQL 5.6.51 제약 (적용 전 반드시 숙지)
-- ─────────────────────────────────────────────────────────────────────────────
--  1) CREATE TABLE IF NOT EXISTS 는 5.6 지원 → 본 파일은 그 자체로 멱등(존재 시 무시).
--     ⚠ 단, 이미 다른 스키마로 존재하는 테이블에는 IF NOT EXISTS 가 컬럼을 보정하지 않는다.
--        (신규 테이블이므로 통상 문제 없음. 재적용 안전.)
--  2) DATETIME DEFAULT CURRENT_TIMESTAMP / ON UPDATE CURRENT_TIMESTAMP 는 5.6.5+ 지원
--     (동일 테이블 다중 자동 타임스탬프 컬럼 허용). 001 hp_standard_answer 선례 동일.
--  3) MEDIUMTEXT/TEXT 는 컬럼 DEFAULT 지정 불가 → extracted_text/summary/tags/services/error 는 NULL 허용만.
--     또한 TEXT 계열은 접두 길이 없이 일반 인덱스 대상 아님 → 인덱스는 스칼라 컬럼에만.
--  4) FULLTEXT 미사용: 현재 키워드 검색은 LIKE MVP. extracted_text 에 FULLTEXT 를 넣지 않는다
--     (5.6 InnoDB FULLTEXT 는 가능하나 본 단계 요구 아님 — 추후 필요 시 009+ 에서 별도 검토).
--  5) FK 미사용: created_by(직원 이메일), services(서비스 slug JSON 문자열) 등은 앱이 참조 정합성 검증.
--  6) row size: utf8mb4 큰 VARCHAR 다수 + TEXT 계열은 InnoDB 8126B off-page 저장으로 흡수됨.
--     본문 대용량은 MEDIUMTEXT(최대 16MB) extracted_text 사용(TEXT 64KB 초과 대비).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ 적용 방식 — 006/007 선례와 동일 (일회용 엔드포인트)
-- ─────────────────────────────────────────────────────────────────────────────
--   003/005/006/007 선례: 일회용 라우트 → 배포 → 실행 → 제거 → 재배포(404).
--   적용 엔드포인트는 information_schema 로 테이블 부재를 확인한 뒤 CREATE 를 1회 실행한다
--   (CREATE TABLE IF NOT EXISTS 자체가 멱등이므로 존재해도 에러 없이 통과).
--   DBA 는 적용하지 않는다(설계·정합만).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⛔ tb_* 무수정 보증
-- ─────────────────────────────────────────────────────────────────────────────
--   PMS 원본 tb_* 테이블은 본 마이그레이션에서 일절 수정하지 않는다. DDL 대상은 hp_material(hp_*) 신설뿐이다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ 기존 데이터 영향 / backfill
-- ─────────────────────────────────────────────────────────────────────────────
--   신규 테이블이므로 backfill 없음. 기존 데이터 영향 없음(신설).
--
-- 롤백: 파일 하단 [롤백] 섹션 — DROP TABLE. 등록·색인된 자료 메타 전부 소실 주의(R2 원본은 별도).
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- [적용 전 점검] — 테이블 부재 확인(있으면 CREATE 는 IF NOT EXISTS 로 통과). 적용 엔드포인트가 자동 수행.
-- ─────────────────────────────────────────────────────────────────────────────
--   SELECT TABLE_NAME
--     FROM information_schema.TABLES
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME   = 'hp_material';


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ hp_material — 학습 자료 카탈로그                                            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
CREATE TABLE IF NOT EXISTS hp_material (
  id              INT NOT NULL AUTO_INCREMENT,
  name            VARCHAR(200) NOT NULL COMMENT '자료명(표시용)',
  type            ENUM('file','url','text','qa') NOT NULL COMMENT '자료 종류. file=업로드파일, url=웹출처, text=직접입력, qa=Q&A쌍',
  source          VARCHAR(1000) NULL COMMENT '파일명 / URL / 출처 표기',
  format          VARCHAR(30) NULL COMMENT 'PDF·DOCX·TXT·MD·URL·Q&A 등 표시용 포맷',
  r2_key          VARCHAR(500) NULL COMMENT 'file 타입 R2 오브젝트 키(원본 보관). file 외 타입은 NULL',
  mime            VARCHAR(150) NULL COMMENT '업로드 파일 MIME 타입',
  size_bytes      BIGINT NULL COMMENT '원본 바이트 크기',
  index_status    ENUM('processing','indexed','stored','failed') NOT NULL DEFAULT 'processing'
                    COMMENT '색인 라이프사이클. processing=처리중, indexed=본문추출·색인완료, stored=저장됐으나 본문추출 미지원(예:이미지PDF), failed=실패(error 참조)',
  summary         TEXT NULL COMMENT '미리보기/자동요약(표시용)',
  extracted_text  MEDIUMTEXT NULL COMMENT '키워드 검색용 추출 본문(LIKE MVP). 최대 16MB. FULLTEXT 미사용',
  chunks          INT NOT NULL DEFAULT 0 COMMENT '분할 청크 수(색인 산출)',
  tags            TEXT NULL COMMENT '태그 JSON 배열 문자열. 예: ["환불","배송"]',
  services        TEXT NULL COMMENT '연관 서비스 slug JSON 배열 문자열. 앱이 정합 검증(FK 없음)',
  error           VARCHAR(500) NULL COMMENT 'index_status=failed 사유',
  created_by      VARCHAR(100) NULL COMMENT '등록한 직원 이메일 (FK 없음, 앱 검증)',
  status          TINYINT NOT NULL DEFAULT 1 COMMENT '1=active, -1=deleted (soft delete)',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_status_type (status, type),
  KEY idx_status_index (status, index_status),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='학습 자료 카탈로그 (챗봇 지식 소스 — 파일/URL/텍스트/Q&A)';


-- ─────────────────────────────────────────────────────────────────────────────
-- [적용 후 확인]
--   SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
--     FROM information_schema.TABLES
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hp_material';
--
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hp_material'
--    ORDER BY ORDINAL_POSITION;
--
--   SHOW INDEX FROM hp_material;   -- PRIMARY, idx_status_type, idx_status_index, idx_created_at
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- [롤백] — 테이블 DROP. ⚠ 등록·색인된 자료 메타 전부 소실(R2 원본 오브젝트는 별도 정리 필요).
-- ═════════════════════════════════════════════════════════════════════════════
--  DROP TABLE IF EXISTS hp_material;
-- ═════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════
-- [적용 명령 예시] — 운영자가 일회용 엔드포인트 대신 직접 실행할 경우 참고.
--   ⚠ 적용 대상 DB: 221.143.42.213 (MySQL 5.6.51), DB pms
--
--   mysql -h 221.143.42.213 -u <USER> -p pms < migrations/008_material.sql
--
--   또는 세션 접속 후:
--   USE pms;
--   SOURCE /path/to/migrations/008_material.sql;
-- ═════════════════════════════════════════════════════════════════════════════
