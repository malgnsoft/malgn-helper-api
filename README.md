# malgn-helper-api

Malgn Helper **API 서버** — Hono on Cloudflare Workers.

검색·LLM·DB·R2 접근을 모두 담당하는 중앙 백엔드. 모든 프론트엔드(`malgn-helper`, `malgn-helper-admin`, `malgn-helper-pms`)가 이 API를 호출한다.

## 책임 영역

- 챗 요청 처리 (표준답변 매칭 → 하이브리드 검색 → Claude 호출 → 출처 인용 응답)
- 자료 업로드 → R2 저장 → 인덱싱 트리거
- 표준 답변·자료·문의·추천답변 CRUD
- 추천 답변 채택/수정/거절 피드백 수집
- 챗 세션·메시지·에스컬레이션 관리 (Phase 2)

## 인프라 바인딩

- **Hyperdrive** → Aurora MySQL (DB 풀링·캐싱)
- **OpenSearch** (k-NN + BM25 하이브리드)
- **R2** (원본 파일)
- **AI Gateway** → Anthropic Claude
- (Phase 2 옵션) **Queues** → Indexer Worker (동영상/대용량 비동기)

## 제약

- DB 직접 연결 금지 — 반드시 Hyperdrive 바인딩
- LLM 직접 호출 금지 — 반드시 AI Gateway 경유 (캐싱·로깅·rate limit)
- 답변 생성 시 출처 인용 누락 금지

## 개발·배포

```bash
pnpm install              # 의존성 설치
pnpm dev                  # 로컬 개발 (wrangler dev)
pnpm deploy               # Cloudflare Workers 배포 (wrangler deploy)
pnpm typecheck            # 타입 체크
```

최초 배포 시 `wrangler login` 또는 `CLOUDFLARE_API_TOKEN` 환경변수 필요.

## 참고

- 상위 워크스페이스: [malgn-helper](https://github.com/malgnsoft/malgn-helper)
- 설계 문서: [CLAUDE.md](https://github.com/malgnsoft/malgn-helper/blob/main/CLAUDE.md), [doc/tech-stack.md](https://github.com/malgnsoft/malgn-helper/blob/main/doc/tech-stack.md)
