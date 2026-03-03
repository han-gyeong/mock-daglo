# mock-daglo

내부용 Daglo MVP 시작 구현입니다.

## 실행
```bash
node server.js
```

브라우저에서 `http://localhost:3000` 접속.

## 현재 구현 범위
- 이름 기반 세션 생성: `POST /api/session`
- 파일 업로드 작업 생성: `POST /api/jobs` (JSON base64)
- 브라우저 녹음 업로드 작업 생성: `POST /api/jobs/recording` (JSON base64)
- 작업 상태 조회: `GET /api/jobs/:jobId`
- 결과 조회: `GET /api/jobs/:jobId/result`
- 최근 작업 목록 조회: `GET /api/jobs`

## UI 흐름 (토스 스타일 참고, 페이지 전환형)
1. `/` 시작 페이지: 이름 입력
2. `/upload.html`: 파일 업로드 또는 브라우저 녹음
3. `/jobs.html`: 작업 목록 확인
4. `/result.html?jobId=...`: 작업 결과 조회

> 현재 STT/요약은 샘플 결과를 반환하며, 실제 외부 API 연동은 TODO입니다.
