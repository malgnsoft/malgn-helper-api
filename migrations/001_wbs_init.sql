-- migrations/001_wbs_init.sql
-- WBS 스키마 + 초기 시드 데이터 (doc/WBS.md 미러)

CREATE TABLE IF NOT EXISTS wbs_stages (
  id          TEXT PRIMARY KEY,            -- 'P1-1', 'P1-2', ...
  phase       INTEGER NOT NULL,            -- 1 or 2
  name        TEXT NOT NULL,
  weight      INTEGER NOT NULL,            -- 가중치 %
  progress    INTEGER NOT NULL DEFAULT 0,  -- 진행률 %
  summary     TEXT,
  sort_order  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wbs_tasks (
  id              TEXT PRIMARY KEY,            -- 'P1-1-1', 'P1-3-9', ...
  stage_id        TEXT NOT NULL,
  task_no         TEXT NOT NULL,               -- '1-1', '3-9', etc.
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- done/in_progress/pending/blocked
  note            TEXT,
  target_date     TEXT,                        -- YYYY-MM-DD
  completion_date TEXT,                        -- YYYY-MM-DD
  sort_order      INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (stage_id) REFERENCES wbs_stages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wbs_tasks_stage ON wbs_tasks(stage_id);
CREATE INDEX IF NOT EXISTS idx_wbs_tasks_status ON wbs_tasks(status);

-- ==================== 시드 (Phase 1 — 2026-05-29 기준) ====================

INSERT INTO wbs_stages (id, phase, name, weight, progress, summary, sort_order) VALUES
  ('P1-1', 1, '착수/분석',     10, 70, '환경 검토 완료, 자료 인벤토리 완료, 요구사항 일부 정의',                                  1),
  ('P1-2', 1, '설계',           25, 40, 'WBS·아키텍처·PMS 디자인 시안 2종 통합, 데이터 모델 미진',                                 2),
  ('P1-3', 1, '구현',           40, 25, '4개 repo 보일러플레이트·배포 완료, PMS 애드온 데모 완성, API 본 로직·DB 미진',           3),
  ('P1-4', 1, '교육 및 연동',   20, 10, '배포 자동화·이력 시스템 셋업. 정식 운영 가이드·연동 미진',                                 4),
  ('P1-5', 1, '테스트',         20,  0, '미시작',                                                                                       5),
  ('P1-6', 1, '이행',            5,  5, '4개 repo 보일러플레이트 첫 배포 완료. Phase 1 본 기능 미배포',                              6);

INSERT INTO wbs_tasks (id, stage_id, task_no, title, status, note, target_date, completion_date, sort_order) VALUES
  -- P1-1 착수/분석
  ('P1-1-1',  'P1-1', '1-1', '요구사항 도출',                       'in_progress', 'CLAUDE.md/ROADMAP에 정의, 정식 정의서 별도 필요', '2026-06-10', NULL,           1),
  ('P1-1-2',  'P1-1', '1-2', '수행범위 정의 및 확인',                'done',        'Phase 1·2 분리, 4 repo 정의 (helper·admin·api·pms)', '2026-05-28', '2026-05-28', 2),
  ('P1-1-3',  'P1-1', '1-3', '개발환경 검토',                        'done',        'Cloudflare 셋업·배포 완료. Aurora/OpenSearch 별도 진행', '2026-05-28', '2026-05-28', 3),
  ('P1-1-4',  'P1-1', '1-4', '기본자료 검토',                        'done',        '레거시 PMS DB 인벤토리, 200+ 프로젝트 분석, 처리 전략 수립', '2026-05-28', '2026-05-28', 4),

  -- P1-2 설계
  ('P1-2-1',  'P1-2', '2-1', '전체 진행 일정 (WBS)',                 'done',        'WBS.md + /wbs 페이지', '2026-05-29', '2026-05-29', 1),
  ('P1-2-2',  'P1-2', '2-2', '시스템 아키텍처 설계',                 'in_progress', '데이터 흐름 다이어그램 완료, 상세 시퀀스 미진', '2026-06-15', NULL,           2),
  ('P1-2-3',  'P1-2', '2-3', '화면명세서 작성',                      'in_progress', 'PMS 카드 2종 시안 통합. 관리자 화면 미진', '2026-06-20', NULL,           3),
  ('P1-2-4',  'P1-2', '2-4', '데이터 설계',                          'pending',     'Aurora ERD, OpenSearch 인덱스 매핑, R2 키 규칙', '2026-06-12', NULL,           4),
  ('P1-2-5',  'P1-2', '2-5', '디자인 시안',                          'in_progress', '브리핑·Q&A 평가 카드 완료. 관리자 시안 미진', '2026-06-20', NULL,           5),
  ('P1-2-6',  'P1-2', '2-6', 'AI 프로토타입 서비스 구현',            'pending',     '실 검색 + Claude 호출 PoC 필요', '2026-06-25', NULL,           6),

  -- P1-3 구현 (DB)
  ('P1-3-1',  'P1-3', '3-1', 'DB 구축',                              'pending',     'Aurora 인스턴스 · Hyperdrive 바인딩 · 스키마 마이그레이션', '2026-06-15', NULL, 1),
  -- P1-3 구현 (디자인/퍼블)
  ('P1-3-2',  'P1-3', '3-2', 'Front 디자인',                         'in_progress', 'PMS 카드 2종. 관리자 본격 화면 미진', '2026-07-05', NULL,           2),
  ('P1-3-3',  'P1-3', '3-3', 'Front 퍼블리싱',                       'in_progress', 'Nuxt 3 컴포넌트 마크업 완료', '2026-07-10', NULL,           3),
  ('P1-3-4',  'P1-3', '3-4', '디자인/퍼블리싱 검수',                 'in_progress', 'Tailwind v4 · Nuxt UI v3 호환성 이슈 수정 진행', '2026-07-12', NULL,           4),
  -- P1-3 구현 (API)
  ('P1-3-5',  'P1-3', '3-5', '워커 및 프레임워크 설치',              'done',        'Hono Worker 부트스트랩 + 첫 배포', '2026-05-28', '2026-05-28', 5),
  ('P1-3-6',  'P1-3', '3-6', 'API 개발',                             'in_progress', '/wbs 엔드포인트 D1 연동 완료. 자료/검색/추천 미진', '2026-07-20', NULL, 6),
  -- P1-3 구현 (Admin)
  ('P1-3-7',  'P1-3', '3-7', 'Admin · AI 설정 페이지',               'pending',     'Nuxt 보일러플레이트만', '2026-07-15', NULL,           7),
  ('P1-3-8',  'P1-3', '3-8', 'Admin · AI 시연 페이지',               'pending',     NULL, '2026-07-25', NULL,           8),
  -- P1-3 구현 (PMS 애드온)
  ('P1-3-9',  'P1-3', '3-9', 'PMS · 브리핑 카드 통합',               'done',        'BriefingCard + 워크플로 페이지', '2026-05-28', '2026-05-28', 9),
  ('P1-3-10', 'P1-3', '3-10','PMS · Q&A 평가 카드 통합',             'done',        'QaEvalCard + 5축 평가', '2026-05-28', '2026-05-28', 10),
  ('P1-3-11', 'P1-3', '3-11','PMS · 워크플로 페이지',                'done',        '빈 상태 → AI 생성 → 히스토리 셀렉트', '2026-05-28', '2026-05-28', 11),
  ('P1-3-12', 'P1-3', '3-12','PMS · 임베드 인터페이스',              'done',        '?modal=open · window.open · iframe + postMessage', '2026-05-28', '2026-05-28', 12),
  ('P1-3-13', 'P1-3', '3-13','PMS · 표준답변 다중 템플릿 + 저장',   'done',        '6종 스타일 · localStorage 영속', '2026-05-28', '2026-05-28', 13),
  ('P1-3-14', 'P1-3', '3-14','PMS · 실제 API 연동',                  'pending',     '현재 localStorage mock → 실 API로 교체', '2026-07-10', NULL, 14),
  ('P1-3-15', 'P1-3', '3-15','PMS · Q&A 평가 워크플로 페이지',       'pending',     '브리핑 카드 패턴을 Q&A에도 적용', '2026-07-05', NULL, 15),

  -- P1-4 교육·연동
  ('P1-4-1',  'P1-4', '4-1', '개발자 가이드 작성',                   'in_progress', '배포 절차·이력 시스템·분류 규칙 메모리. 운영 가이드 본격 미진', '2026-08-01', NULL, 1),
  ('P1-4-2',  'P1-4', '4-2', '개발자 교육',                          'pending',     NULL, '2026-08-10', NULL, 2),
  ('P1-4-3',  'P1-4', '4-3', '서비스 연동',                          'pending',     '기존 CS 시스템 · SSO 연동', '2026-08-15', NULL, 3),

  -- P1-5 테스트
  ('P1-5-1',  'P1-5', '5-1', '베타 오픈(테스트 서버)',               'pending',     NULL, '2026-08-05', NULL, 1),
  ('P1-5-2',  'P1-5', '5-2', '단위 테스트',                          'pending',     NULL, '2026-07-25', NULL, 2),
  ('P1-5-3',  'P1-5', '5-3', '통합 테스트',                          'pending',     NULL, '2026-08-10', NULL, 3),
  ('P1-5-4',  'P1-5', '5-4', '오류 수정작업',                        'in_progress', 'UI 호환성 이슈 다수 처리 (배포 데모 진행 중)', '2026-08-20', NULL, 4),
  ('P1-5-5',  'P1-5', '5-5', '최종 테스트',                          'pending',     NULL, '2026-08-25', NULL, 5),

  -- P1-6 이행
  ('P1-6-1',  'P1-6', '6-1', '배포',                                 'in_progress', '보일러플레이트 첫 배포만. 본 기능 배포 대기', '2026-08-30', NULL, 1),
  ('P1-6-2',  'P1-6', '6-2', '완료 보고 및 공유',                    'pending',     NULL, '2026-08-31', NULL, 2);
