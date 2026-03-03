# Daglo 설계 문서 (내부 서비스 경량 버전)

## 1) 제품 한 줄 정의
**Daglo**는 내부 팀이 회의/인터뷰 음성을 빠르게 텍스트로 바꾸고, 요약/액션아이템을 확인하는 **경량 웹 도구**다.

---

## 2) 이번 버전의 설계 원칙
1. **로그인 없음**: 인증은 미래 TODO. 입장 시 이름만 입력.
2. **DB 없음**: 가능하면 애플리케이션 메모리 + 로컬 파일(JSON) 기반.
3. **빠른 구현 우선**: 운영 안정성보다 내부 사용성과 개발 속도 우선.
4. **나중에 교체 가능**: 추후 DB/Auth 붙이기 쉬운 구조로 인터페이스 분리.

---

## 3) 사용자 흐름 (MVP)
1. 사용자가 접속 후 이름 입력 (`displayName`)
2. **두 가지 입력 방식 중 선택**
   - A) 기존 파일 업로드
   - B) 브라우저에서 바로 녹음 후 저장(나중 업로드)
3. 서버가 전사(STT) 수행
4. 요약/핵심 포인트/액션 아이템 생성
5. 결과를 화면에서 확인 및 복사

### 브라우저 녹음 UI 시나리오 (추가)
1. `녹음 시작` 클릭 → `MediaRecorder`로 마이크 수집 시작
2. `일시정지/재개` 지원 (선택)
3. `녹음 종료` 후 브라우저 메모리(Blob) 또는 임시 로컬 저장(IndexDB)
4. 사용자가 제목 입력 후 `업로드` 클릭
5. 업로드 성공 시 `jobId` 발급, 이후는 기존 처리 파이프라인 동일

---

## 4) MVP 기능 범위

### 포함
- 이름 기반 입장(임시 세션)
- 오디오 업로드(파일 선택)
- 브라우저 녹음 후 업로드
- 전사 결과 조회(타임스탬프 포함 가능)
- 요약 + 액션아이템 생성
- 최근 작업 목록 조회

### 제외 (TODO)
- 이메일/소셜 로그인
- 권한 관리(RBAC)
- 조직/프로젝트 멀티테넌시
- 정식 검색 인덱스(OpenSearch)
- 과금/플랜

---

## 5) 경량 아키텍처

```text
[Browser]
   |
   v
[Single Node App (Next.js or Fastify)]
   |- Upload API
   |- Browser Recording Upload API
   |- STT/NLP Orchestrator
   |- In-memory Store (실행 중 상태)
   |- File Store Adapter (JSON 파일 영속화)
   |
   +--> [Object Storage optional: local ./data/uploads]
   +--> [External STT API]
   +--> [External LLM API]
```

### 핵심 포인트
- 서버 프로세스 하나로 운영(초기)
- 큐 시스템 없이도 시작 가능: 요청 수가 적다는 전제
- 긴 작업은 `jobId`를 발급하고 폴링으로 상태 조회

---

## 6) 데이터 저장 전략 (DB 없이)

## 디렉토리 구조 예시
```text
./data
  /uploads        # 원본 오디오
  /jobs           # 작업 상태 JSON
  /results        # 전사/요약 결과 JSON
```

## JSON 스키마 예시
### job (`data/jobs/{jobId}.json`)
```json
{
  "jobId": "job_123",
  "displayName": "minsu",
  "filePath": "./data/uploads/a.wav",
  "status": "queued|processing|completed|failed",
  "createdAt": "2026-03-03T10:00:00Z",
  "updatedAt": "2026-03-03T10:01:00Z"
}
```

### result (`data/results/{jobId}.json`)
```json
{
  "jobId": "job_123",
  "transcript": [{ "speaker": "SPEAKER_1", "startMs": 0, "endMs": 1200, "text": "안녕하세요" }],
  "summary": "...",
  "keyPoints": ["..."],
  "actionItems": ["..."],
  "speakerHighlights": ["..."],
  "decisions": ["..."],
  "openQuestions": ["..."]
}
```

---

## 7) API 설계 (간단)

### 1) 이름으로 입장
`POST /api/session`
- req: `{ displayName }`
- res: `{ sessionId, displayName }`

> 세션은 signed cookie 또는 메모리 맵으로 임시 관리.

### 2) 파일 업로드 + 작업 생성
`POST /api/jobs`
- multipart: audio file
- res: `{ jobId, status: "queued" }`

### 2-1) 브라우저 녹음 업로드 + 작업 생성
`POST /api/jobs/recording`
- multipart: recorded audio blob (webm/wav)
- req(optional): `{ title }`
- res: `{ jobId, status: "queued" }`

### 3) 작업 상태 조회
`GET /api/jobs/{jobId}`
- res: `{ jobId, status, progress? }`

### 4) 결과 조회
`GET /api/jobs/{jobId}/result`
- res: `{ transcript, summary, keyPoints, actionItems, speakerHighlights, decisions, openQuestions }`

### 5) 최근 작업 목록
`GET /api/jobs?mine=true`
- res: `[{ jobId, status, createdAt }]`

---

## 8) 처리 파이프라인 (간소화)
1. 업로드 파일 저장(파일 선택/브라우저 녹음 공통)
2. job JSON 생성 (`queued`)
3. 백그라운드 처리 시작 (`processing`)
4. STT API 호출
5. LLM 요약/액션아이템 생성
6. 결과 JSON 저장
7. job 상태 `completed` 업데이트

실패 시 `failed`와 `errorMessage` 저장.

---

## 9) 기술 선택 제안
- **프론트/백 통합**: Next.js(App Router + Route Handler)
- 또는 **API 서버 단독**: Fastify + 간단한 템플릿 프론트
- 파일 처리: `multer` 또는 Next 업로드 핸들러
- 브라우저 녹음: `MediaRecorder API` + `getUserMedia`
- 스케줄/백그라운드: Node worker thread 또는 단순 비동기 태스크 큐(메모리)

---

## 10) 제약/리스크
1. 프로세스 재시작 시 메모리 상태 유실 가능
2. 동시 요청이 많아지면 처리 지연
3. 파일 기반 저장은 동시성/정합성 한계
4. 로그인/권한이 없어 내부망 전제 필요

---

## 11) 확장 경로 (나중에)
1. 파일 기반 저장 → PostgreSQL
2. 임시 세션 → OAuth/SAML 로그인
3. 인메모리 작업 처리 → Redis + Queue
4. 단순 목록 조회 → 검색엔진 연동

---

## 12) 즉시 실행 TODO
1. 이름 입력 화면 + 세션 쿠키 구현
2. 파일 업로드 API + `jobId` 발급
3. 녹음 UI (`시작/중지/미리듣기/업로드`) 구현
4. STT/요약 연동 어댑터(Provider 인터페이스) 작성
5. JSON 파일 저장소 모듈 구현 (`JobRepository`, `ResultRepository`)
6. 작업 상태 폴링 UI 구현
