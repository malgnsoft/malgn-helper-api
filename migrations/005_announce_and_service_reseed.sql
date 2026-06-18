-- migrations/005_announce_and_service_reseed.sql
-- Malgn Helper — (1) 표준 안내답변 전용 테이블 hp_announce 신설
--               (2) hp_service 7서비스 재시드 (OTT·범용·글로벌·공공·유지보수·환급·독립)
-- 실행 위치: 운영 PMS DB (실서버 221.143.42.213, MySQL 5.6.51-log, DB `pms`)
-- 설계 정본:
--   - malgn-helper-mng/docs/PMS-INQUIRY-HARVEST.md §3-1(그룹→서비스 매핑), §4-2(7서비스 재시드안),
--     §5-3(안내글 vs Q&A 분기 · answer_type 폐기 → 별도 테이블 결정)
--   - malgn-helper-mng/docs/STANDARD-ANSWER-CURATION.md §2-1(분류 축), §3(승인 워크플로)
-- 직전 마이그레이션:
--   - 002_admin_console.sql  (hp_service / hp_topic 카탈로그 실체화 + 시드)
--   - 003_standard_answer_curation.sql (hp_standard_answer 분류·승인 컬럼 — 본 테이블 구조의 기준)
--   - 004_bots.sql           (hp_bot — ⚠ 이 파일이 002 시드 슬러그 lms-general/lms-public-security 를 참조)
--
-- ⚠ 슬롯 번호 주의: 사용자 지시는 "004"였으나 004_bots.sql 이 이미 점유 → 충돌 회피로 005 로 부여.
--
-- 컨벤션(002·003·004 동일): utf8mb4 / status TINYINT(1=active,-1=deleted) / DATETIME / ENUM(5.6 지원).
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ MySQL 5.6.51 제약 (적용 전 반드시 숙지)
-- ─────────────────────────────────────────────────────────────────────────────
--  1) JSON 타입·표현식 DEFAULT 미지원 → `tags` 는 LONGTEXT NULL (앱이 직렬화). NULL=미지정, '[]'=빈배열.
--  2) `CREATE TABLE IF NOT EXISTS` 는 5.6 지원(멱등). 그러나 아래 hp_service 재시드 UPDATE/INSERT 는
--     멱등성에 한계가 있다(아래 [재시드] 섹션 주의 참조). 본 파일 1구획(테이블 생성)만 무조건 안전.
--  3) FK 미사용: topic_id/service_id/source_post_id 등은 참조만 하고 DB FK 제약은 걸지 않는다.
--     정합성은 애플리케이션이 검증(HP-SCHEMA §1 원칙 + 003 §4 동일).
--  4) online DDL: CREATE TABLE 은 신규 테이블이라 기존 트래픽 무영향. 재시드 UPDATE 는 소규모.
--
-- 롤백: 파일 하단 [롤백] 섹션 참조.
-- ═════════════════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 1. hp_announce — 표준 안내답변 전용 테이블 (answer_type ENUM 권고 폐기)      ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- [설계 전환 근거 — answer_type ENUM → 별도 테이블]
--   STANDARD-ANSWER-CURATION.md §5-3(이전판) 및 §2-1 은 안내글을
--   `hp_standard_answer.answer_type ENUM('qa','announce')` 컬럼으로 구분(안 A)하라고 권고했다.
--   본 마이그레이션은 사용자 신규 지시에 따라 그 권고를 **폐기**하고 안내글 전용 테이블을 신설한다.
--   별도 테이블 선택 사유:
--     (a) 안내글은 staff(직원) 작성 "공지·정책 안내"로 질문-답변 쌍이 아니다 → `question` NULL 허용 필요.
--         hp_standard_answer.question 은 NOT NULL(001 정의)이라 그대로 쓰면 빈 질문을 강제 채워야 함.
--     (b) 출처가 "고객 문의 게시글"이 아니라 "직원 작성 안내글"이라 출처/말투/P2 노출 가드가 다르다.
--     (c) 매칭(챗봇) 측에서 Q&A 와 안내문을 다른 프롬프트·인용 규칙으로 다뤄야 하므로 물리 분리가 깔끔.
--   단, 분류(scope/topic/service/tags)·승인 워크플로(approval_status 5단계)·출처·채택수는
--   hp_standard_answer(003 적용 후)와 **동일 컬럼·동일 의미**로 맞춰 큐레이션 로직을 공유한다.
--
-- [hp_standard_answer(003 후) 대비 차이]
--   - question        : NOT NULL → **NULL 허용** (안내글엔 명시적 질문이 없을 수 있음 / §5-3 H3).
--   - answer          : 명칭 검토 결과 본 테이블은 본문 의미를 살려 `body` 로 명명. 호환 위해
--                       조회 시 앱이 body→answer 로 매핑하면 hp_standard_answer 와 동형 처리 가능.
--   - title           : 안내 "주제/제목"(공지 제목). hp_standard_answer.label(분류 라벨)과 역할이 겹쳐
--                       label 은 분류용으로, title 은 공지 제목용으로 둘 다 유지.
--   - source_post_id  : 안내글이 파생된 PMS 게시글 id (staff 첫 글).
--   - merged_into_id / source_uncovered_id : 안내글 트랙에선 거의 안 쓰이나, 큐레이션(중복/병합) 로직
--                       재사용을 위해 동형 유지(NULL 기본). 미커버 전환은 Q&A 전용이라 사실상 NULL.
--
-- ※ embedding 은 003 과 동일하게 DB 컬럼이 아니라 OpenSearch k-NN 색인으로 분리(여기 미포함).
CREATE TABLE IF NOT EXISTS hp_announce (
  id                   INT NOT NULL AUTO_INCREMENT,

  -- ── 본문 ──
  title                VARCHAR(150) NOT NULL
        COMMENT '안내 주제/제목 (공지 제목). 목록 표기·검색 키',
  label                VARCHAR(100) NULL
        COMMENT '분류 라벨 (hp_standard_answer.label 과 동형, 안내글은 선택)',
  question             TEXT NULL
        COMMENT '안내글엔 명시적 질문이 없을 수 있어 NULL 허용 (§5-3 H3). 있으면 "어떤 상황의 안내인지"',
  body                 TEXT NOT NULL
        COMMENT '안내 본문(= 답변 콘텐츠). 조회 시 앱이 answer 로 매핑하면 SA 와 동형 처리',

  -- ── 분류 (003 hp_standard_answer 와 동일 축·동일 의미) ──
  scope                ENUM('common','service') NOT NULL DEFAULT 'service'
        COMMENT 'common=전 솔루션 공통, service=특정 서비스 전용 (§2-1)',
  topic_id             INT NULL
        COMMENT 'hp_topic.id (FK 없음, 앱 검증). 주제 분류',
  service_id           INT NULL
        COMMENT 'hp_service.id (FK 없음, 앱 검증). scope=service 일 때만 의미',
  tags                 LONGTEXT NULL
        COMMENT '자유 태그 JSON 직렬화 (5.6 JSON 미지원 → LONGTEXT). NULL=미지정 "[]"=빈배열',

  -- ── 승인 워크플로 (003 과 동일 ENUM·동일 라이프사이클) ──
  approval_status      ENUM('draft','reviewing','approved','rejected','archived') NOT NULL DEFAULT 'draft'
        COMMENT '큐레이션 라이프사이클 (§3-2). 챗봇은 approved 만 사용. status(soft-delete)와 분리',
  approved_by          VARCHAR(100) NULL COMMENT '승인/반려 처리 직원 이메일 (§3-4)',
  approved_at          DATETIME NULL COMMENT '승인 시각 (§3-4)',
  rejection_reason     VARCHAR(255) NULL COMMENT '반려 사유 — 반려 시 필수 (§3-4)',

  -- ── 중복/병합 (003 동형, 큐레이션 로직 공유용) ──
  merged_into_id       INT NULL
        COMMENT '병합 흡수 시 생존(primary) hp_announce.id. 흡수 row 는 status=-1 (§4-2)',
  source_uncovered_id  INT NULL
        COMMENT 'hp_uncovered_question.id (Phase 2). 안내글 트랙에선 사실상 NULL — SA 동형 유지용',

  -- ── 출처 (안내글 = staff 첫 글) ──
  source_post_id       INT NULL COMMENT '안내글이 파생된 PMS tb_post.id (staff 작성)',
  created_by           VARCHAR(100) NULL COMMENT '저장(수집)한 직원 이메일',

  -- ── 채택 신호 (003/001 동형) ──
  usage_count          INT NOT NULL DEFAULT 0 COMMENT '채택수(챗봇/상담사 사용)',
  last_used_at         DATETIME NULL,

  -- ── 소프트삭제 / 타임스탬프 (전 테이블 공통 컨벤션) ──
  status               TINYINT NOT NULL DEFAULT 1 COMMENT '1=active, -1=deleted (soft delete)',
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- 승인 대기 큐 깊이·챗봇 approved 필터 (003 idx_approval 과 동형)
  KEY idx_approval (approval_status, status),
  -- 분류 매칭(§2-3): scope→topic→service 순 선택도, status 로 활성행만 (003 idx_scope_topic 동형)
  KEY idx_scope_topic (scope, topic_id, service_id, status),
  -- 병합 역추적(§4-2)
  KEY idx_merged (merged_into_id),
  -- 출처 게시글 역참조
  KEY idx_source_post (source_post_id),
  -- 채택수 정렬
  KEY idx_usage (status, usage_count),
  -- 한국어는 ngram 파서 미설정 상태라 코드가 LIKE 사용(003 idx_qa 와 동일 한계).
  -- 본문 전문검색은 OpenSearch 로 이관 — 여기선 title/body FULLTEXT 를 호환용으로만 둔다.
  FULLTEXT KEY idx_announce_ft (title, body)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='표준 안내답변(직원 작성 공지·정책 안내) 카탈로그';


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 2. hp_service 7서비스 재시드                                                ║
-- ║    (OTT·범용·글로벌·공공·유지보수·환급·독립)                                  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠⚠ 파괴적 변경 가능성 — 적용 전 사용자(운영자) 확인 필수. 아래는 기본 "주석 처리".
-- ─────────────────────────────────────────────────────────────────────────────
--
-- [현황 — 002 시드 6종]
--   step / lms-general / lms-mixed / lms-private / lms-public-security / lms-global
--   (PMS-INQUIRY-HARVEST §4-1: 목업 기반 가상값. 실제 service_id 참조 데이터 소규모/없음)
--
-- [목표 — 7서비스 (PMS-INQUIRY-HARVEST §4-2, PMS 그룹명 기반 실데이터)]
--   ott / general / global / public / maintenance / refund / standalone
--
-- [역참조 영향 분석 — service_id 를 가리키는 곳]
--   ① hp_standard_answer.service_id (003 추가) — 현재 약 3행, 분류 미실체화 → service_id 거의 NULL.
--      003 §27 backfill 도 기본 주석이라 운영 데이터의 service_id 매핑 사례는 사실상 없음(영향 낮음).
--   ② hp_announce.service_id (위 1구획 신설) — 신규라 데이터 없음(영향 없음).
--   ③ ⚠ hp_bot.service_id (004_bots.sql) — 004 시드가 슬러그 'lms-general' / 'lms-public-security'
--      를 **서브쿼리로 해석해 INSERT** 한다. 아래 방식에 따라 다음 충돌이 발생한다:
--        - (A) soft-delete 후 신규 INSERT 방식: 기존 6종 행이 status=-1 이 되면, 004 가 이미 적용돼
--          생성한 hp_bot 행의 service_id 는 **삭제된 service 행을 가리키는 dangling 참조**가 된다
--          (FK 없으니 에러는 안 나지만 catalog 조인 시 안 보임). 또 004 를 본 005 이후 재실행하면
--          'lms-general'/'lms-public-security' 서브쿼리가 status=1 행을 못 찾아 봇 시드가 누락된다.
--        - (B) UPDATE 재매핑 방식: 기존 행의 slug/name 을 7종으로 바꾸면 hp_bot.service_id 의
--          정수 id 는 유지되나 **가리키는 서비스의 의미가 바뀐다**(예: lms-general→general 은 의미 보존,
--          그러나 6→7 매핑이 1:1 이 아니라 일부는 신규/삭제라 어긋남).
--      → 결론: hp_service 재시드는 **004_bots.sql 시드 슬러그 정본화와 함께** 처리해야 한다.
--         BOTS-PLAN §1 "슬러그 정본화"가 이 7서비스로 확정되면 004 시드도 동반 수정(별도 작업).
--
-- [방식 비교 — H2 (PMS-INQUIRY-HARVEST §4-3, STANDARD-ANSWER-CURATION T1)]
--   (A) 002 6종 soft-delete(status=-1) 후 7종 신규 INSERT
--       + 장점: 이력 보존(과거 6종 행 남음), id 충돌 없음.
--       - 단점: hp_bot 등 기존 service_id 참조가 삭제 행을 가리키게 됨(위 ③-A). 재시드 후 catalog 에
--               활성 7종만 노출되나, 구 id 를 참조하던 데이터의 재매핑 backfill 이 별도로 필요.
--   (B) 기존 행 UPDATE 재매핑(slug/name 교체) + 부족분 INSERT + 잉여분 soft-delete
--       + 장점: 의미가 보존되는 매핑(lms-general→general, lms-global→global, lms-public-security→public)
--               은 id 를 유지해 역참조가 자연 승계.
--       - 단점: 매핑 규칙이 사람 판단(아래 표). 멱등 아님. 잘못 매핑 시 의미 오염.
--
-- [권고]
--   운영 catalog(/catalog)에서 002 6종이 이미 편집됐는지 먼저 확인(SELECT 아래) 후,
--   데이터가 실질적으로 없으면 **(A) soft-delete + INSERT** 가 가장 안전하고 추적 쉽다.
--   단 hp_bot 시드 동반 수정(004 슬러그→7종)을 같은 배포 창에서 처리한다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- [적용 전 점검] — 반드시 먼저 실행해 현재 상태·역참조를 확인한다.
-- ─────────────────────────────────────────────────────────────────────────────
--   SELECT id, slug, name, status FROM hp_service ORDER BY sort_order;
--   SELECT id, name, service_id, status FROM hp_bot;                 -- 004 적용 시
--   SELECT id, service_id FROM hp_standard_answer WHERE service_id IS NOT NULL;
--   SELECT id, service_id FROM hp_announce WHERE service_id IS NOT NULL;  -- 신규(보통 0건)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- [방식 A] 002 6종 soft-delete 후 7종 신규 INSERT  ── 기본 주석. 확인 후 해제·1회 실행.
-- ─────────────────────────────────────────────────────────────────────────────
--
--  -- A-1) 기존 6종을 soft-delete (이력 보존). 주석 해제 전 위 [점검] 으로 참조 확인.
--  UPDATE hp_service
--     SET status = -1
--   WHERE slug IN ('step','lms-general','lms-mixed','lms-private','lms-public-security','lms-global')
--     AND status = 1;
--
--  -- A-2) 7서비스 INSERT. slug UNIQUE(uk_slug) 이므로 ON DUPLICATE KEY 로 멱등(재실행 시 부활·정정).
--  --       재시드 의미상 status=1, active=1 로 (재)활성화.
--  INSERT INTO hp_service (slug, name, note, sort_order, active, status) VALUES
--    ('ott',        'OTT',     'OTT 서비스',                       10, 1, 1),
--    ('general',    '범용',    '맑은이러닝(범용 LMS) — 오픈전/후 포함', 20, 1, 1),
--    ('global',     '글로벌',  '글로벌이러닝(해외·영문)',           30, 1, 1),
--    ('public',     '공공',    '공공클라우드',                     40, 1, 1),
--    ('maintenance','유지보수','유지보수 프로젝트',                 50, 1, 1),
--    ('refund',     '환급',    '환급과정 유지보수(고용보험 환급)',   60, 1, 1),
--    ('standalone', '독립',    '독립 LMS(온프레미스/단독)',         70, 1, 1)
--  ON DUPLICATE KEY UPDATE
--    name=VALUES(name), note=VALUES(note), sort_order=VALUES(sort_order),
--    active=VALUES(active), status=VALUES(status);
--
-- ─────────────────────────────────────────────────────────────────────────────
-- [방식 B] UPDATE 재매핑 (의미 보존 매핑 + 부족분 INSERT + 잉여분 soft-delete) ── 대안. 주석.
-- ─────────────────────────────────────────────────────────────────────────────
--   의미 보존 매핑(권고 매핑):
--     lms-general          → general    (범용)
--     lms-global           → global     (글로벌)
--     lms-public-security  → public     (공공)
--   삭제(7종에 대응 없음):
--     step, lms-mixed, lms-private  → status=-1
--   신규(매핑 소스 없음 → INSERT):
--     ott, maintenance, refund, standalone
--
--  -- B-1) 의미 보존 재매핑
--  UPDATE hp_service SET slug='general', name='범용',   note='맑은이러닝(범용 LMS)',     sort_order=20 WHERE slug='lms-general' AND status=1;
--  UPDATE hp_service SET slug='global',  name='글로벌', note='글로벌이러닝(해외·영문)',   sort_order=30 WHERE slug='lms-global' AND status=1;
--  UPDATE hp_service SET slug='public',  name='공공',   note='공공클라우드',             sort_order=40 WHERE slug='lms-public-security' AND status=1;
--  -- B-2) 대응 없는 구종 soft-delete
--  UPDATE hp_service SET status=-1 WHERE slug IN ('step','lms-mixed','lms-private') AND status=1;
--  -- B-3) 신규 4종 INSERT (slug UNIQUE → ON DUPLICATE 멱등)
--  INSERT INTO hp_service (slug, name, note, sort_order, active, status) VALUES
--    ('ott',        'OTT',     'OTT 서비스',                      10, 1, 1),
--    ('maintenance','유지보수','유지보수 프로젝트',                50, 1, 1),
--    ('refund',     '환급',    '환급과정 유지보수(고용보험 환급)',  60, 1, 1),
--    ('standalone', '독립',    '독립 LMS(온프레미스/단독)',        70, 1, 1)
--  ON DUPLICATE KEY UPDATE name=VALUES(name), note=VALUES(note), sort_order=VALUES(sort_order), status=1, active=1;
--
-- ═════════════════════════════════════════════════════════════════════════════
-- [롤백]
-- ═════════════════════════════════════════════════════════════════════════════
--  -- 1. hp_announce 제거 (신규 테이블 → 데이터 손실 주의):
--  --      DROP TABLE IF EXISTS hp_announce;
--  --
--  -- 2. hp_service 재시드 롤백:
--  --   [방식 A 롤백] 7종 soft-delete + 6종 복구:
--  --      UPDATE hp_service SET status=-1 WHERE slug IN ('ott','general','global','public','maintenance','refund','standalone');
--  --      UPDATE hp_service SET status=1  WHERE slug IN ('step','lms-general','lms-mixed','lms-private','lms-public-security','lms-global');
--  --   [방식 B 롤백] 재매핑 역적용 — slug/name 환원 후 신규 4종 soft-delete. (UPDATE 라 자동 역산 불가 → 위 [점검] 백업본 기준 수기 환원)
--  --   ⚠ 재시드 적용 사이 hp_bot/hp_standard_answer 가 신규 service_id 를 참조했다면 롤백 시 dangling 됨 — 동반 점검.
-- ═════════════════════════════════════════════════════════════════════════════
