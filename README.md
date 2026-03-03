# mock-daglo

내부용 Daglo MVP 시작 구현입니다.

## 실행
```bash
node server.js
```

브라우저에서 `http://localhost:3000` 접속.

## AI Provider 설정 (OpenAI / Gemini)
AI 요약 생성은 아래 두 방식 모두 지원합니다.

1) 설정 파일: `config/ai.config.json`
2) 환경변수: 설정 파일 값을 덮어씀

### 설정 파일 예시
```json
{
  "provider": "openai",
  "openai": { "model": "gpt-4o-mini", "apiKey": "" },
  "gemini": { "model": "gemini-1.5-flash", "apiKey": "" }
}
```

### 환경변수 예시
```bash
AI_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini

# 또는
AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-1.5-flash
```

## 현재 구현 범위
- 이름 기반 세션 생성: `POST /api/session`
- 파일 업로드 작업 생성: `POST /api/jobs` (JSON base64)
- 브라우저 녹음 업로드 작업 생성: `POST /api/jobs/recording` (JSON base64)
- 작업 상태 조회: `GET /api/jobs/:jobId` (progress/step 포함)
- 결과 조회: `GET /api/jobs/:jobId/result`
- 최근 작업 목록 조회: `GET /api/jobs`

## UI 흐름 (토스 스타일 참고, 페이지 전환형)
1. `/` 시작 페이지: 이름 입력
2. `/upload.html`: 파일 업로드 또는 브라우저 녹음
3. `/jobs.html`: 작업 목록 + 진행률 확인
4. `/result.html?jobId=...`: 작업 결과 조회

> STT는 현재 샘플 전사 데이터를 사용하고, 요약/키포인트/액션아이템은 선택한 AI Provider(OpenAI/Gemini)로 생성합니다.
