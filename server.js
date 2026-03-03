const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { callOpenAI } = require('./services/openaiClient');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const AI_CONFIG_PATH = path.join(ROOT, 'config', 'ai.config.json');

const sessions = new Map();

const USER_ERROR_MESSAGES = {
  auth: '인증 오류: API 키 또는 권한 설정을 확인해주세요.',
  rate_limit: '모델 한도: 잠시 후 다시 시도해주세요.',
  file_format: '파일 형식 문제: 지원되는 오디오 파일인지 확인해주세요.',
  default: '요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'
};

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }

function maskValue(key, value) {
  if (typeof value !== 'string') return value;
  const lowered = key.toLowerCase();
  if (lowered.includes('apikey') || lowered.includes('authorization')) return '***';
  if (lowered.includes('filepath') || lowered.includes('audio')) return path.basename(value);
  return value;
}

function sanitizeForLog(input) {
  if (!input || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((v) => sanitizeForLog(v));

  const sanitized = {};
  for (const [k, v] of Object.entries(input)) {
    if (v && typeof v === 'object') sanitized[k] = sanitizeForLog(v);
    else sanitized[k] = maskValue(k, v);
  }
  return sanitized;
}

function logWithCorrelation(level, correlationId, message, payload = {}) {
  const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  logger(`[${correlationId}] ${message}`, sanitizeForLog(payload));
}

function classifyError(error) {
  if (error.type === 'auth' || error.status === 401 || error.status === 403) return 'auth';
  if (error.type === 'rate_limit' || error.status === 429) return 'rate_limit';
  if (error.type === 'file_format') return 'file_format';
  return 'default';
}

async function ensureDirs() {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(JOBS_DIR, { recursive: true });
  await fs.mkdir(RESULTS_DIR, { recursive: true });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, body, cookie) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(text);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').filter(Boolean).map((v) => {
    const idx = v.indexOf('=');
    return [v.slice(0, idx).trim(), decodeURIComponent(v.slice(idx + 1))];
  }));
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function loadAiConfig() {
  const raw = await fs.readFile(AI_CONFIG_PATH, 'utf8');
  const fileConfig = JSON.parse(raw);

  return {
    provider: process.env.AI_PROVIDER || fileConfig.provider || 'openai',
    openai: {
      model: process.env.OPENAI_MODEL || fileConfig.openai?.model || 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY || fileConfig.openai?.apiKey || ''
    },
    gemini: {
      model: process.env.GEMINI_MODEL || fileConfig.gemini?.model || 'gemini-1.5-flash',
      apiKey: process.env.GEMINI_API_KEY || fileConfig.gemini?.apiKey || ''
    }
  };
}

function getSession(req) {
  const sid = parseCookies(req).sid;
  return sid ? sessions.get(sid) : null;
}

async function updateJob(jobId, patch) {
  const jobPath = path.join(JOBS_DIR, `${jobId}.json`);
  const job = await readJson(jobPath);
  Object.assign(job, patch, { updatedAt: now() });
  await writeJson(jobPath, job);
  return job;
}

function validateAudioInput(fileName, mimeType) {
  const supportedExt = new Set(['.mp3', '.wav', '.m4a', '.webm', '.ogg']);
  const ext = path.extname(fileName || '').toLowerCase() || '.webm';
  const normalizedMime = (mimeType || '').toLowerCase();
  const mimeAllowed = !normalizedMime || normalizedMime.startsWith('audio/');

  if (!mimeAllowed || !supportedExt.has(ext)) {
    const err = new Error('지원하지 않는 파일 형식입니다.');
    err.type = 'file_format';
    throw err;
  }

  return ext;
}

async function createJob(displayName, fileName, mimeType, contentBase64) {
  if (!contentBase64) throw new Error('contentBase64 required');
  const ext = validateAudioInput(fileName, mimeType);
  const jobId = id('job');
  const filePath = path.join(UPLOAD_DIR, `${jobId}${ext}`);
  await fs.writeFile(filePath, Buffer.from(contentBase64, 'base64'));

  const job = {
    jobId,
    displayName,
    filePath,
    originalName: fileName || `${jobId}${ext}`,
    mimeType: mimeType || 'audio/webm',
    status: 'queued',
    progress: 5,
    step: '업로드 완료, 대기중',
    createdAt: now(),
    updatedAt: now()
  };

  await writeJson(path.join(JOBS_DIR, `${jobId}.json`), job);
  processJob(jobId).catch(async (e) => {
    const errorType = classifyError(e);
    await updateJob(jobId, {
      status: 'failed',
      progress: 100,
      step: '실패',
      errorType,
      errorMessage: USER_ERROR_MESSAGES[errorType] || USER_ERROR_MESSAGES.default
    });
  });
  return job;
}

function buildPrompt(transcript) {
  return [
    '다음 전사 텍스트를 읽고 JSON 형식으로만 답해줘.',
    '{"summary":"...","keyPoints":["..."],"actionItems":["..."]}',
    '각 배열은 최대 3개 항목으로 짧게 작성해줘.',
    '전사:',
    transcript
  ].join('\n');
}

function parseAiJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI 응답 JSON 파싱 실패');
  return JSON.parse(match[0]);
}

async function callGemini(config, prompt, correlationId) {
  if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY 또는 config/ai.config.json 의 gemini.apiKey를 설정하세요.');
  const startedAt = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    })
  });

  if (!resp.ok) {
    const err = new Error(`Gemini API 오류: ${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  logWithCorrelation('info', correlationId, 'Gemini response received', { status: resp.status });

  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    modelInfo: {
      provider: 'gemini',
      model: config.gemini.model,
      promptTokens: data.usageMetadata?.promptTokenCount ?? null,
      completionTokens: data.usageMetadata?.candidatesTokenCount ?? null,
      totalTokens: data.usageMetadata?.totalTokenCount ?? null,
      durationMs: Date.now() - startedAt,
      retryCount: 0
    }
  };
}

async function summarizeWithProvider(transcript, correlationId) {
  const config = await loadAiConfig();
  const prompt = buildPrompt(transcript);
  const provider = (config.provider || '').toLowerCase();

  let response;
  if (provider === 'openai') {
    response = await callOpenAI({
      apiKey: config.openai.apiKey,
      model: config.openai.model,
      prompt,
      correlationId,
      timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 12000),
      maxRetries: Number(process.env.OPENAI_MAX_RETRIES || 3)
    });
  } else if (provider === 'gemini') {
    response = await callGemini(config, prompt, correlationId);
  } else {
    throw new Error(`지원하지 않는 provider: ${config.provider}`);
  }

  const parsed = parseAiJson(response.text);
  return {
    summary: parsed.summary || '',
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 3) : [],
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.slice(0, 3) : [],
    modelInfo: response.modelInfo
  };
}

async function processJob(jobId) {
  const correlationId = id('corr');
  const resultPath = path.join(RESULTS_DIR, `${jobId}.json`);
  const baseJob = await updateJob(jobId, { status: 'processing', progress: 20, step: 'STT 처리 중', correlationId });

  logWithCorrelation('info', correlationId, 'Job started', {
    jobId,
    displayName: baseJob.displayName,
    filePath: baseJob.filePath
  });

  await new Promise((r) => setTimeout(r, 800));

  const transcript = [
    { startMs: 0, endMs: 1200, text: `${baseJob.displayName}님의 녹음 파일 전사 결과(샘플)` },
    { startMs: 1200, endMs: 3500, text: '실제 STT 연동 전까지는 데모 텍스트를 반환합니다.' }
  ];
  await updateJob(jobId, { progress: 55, step: '요약 생성 중(AI)' });

  const transcriptText = transcript.map((v) => v.text).join('\n');
  const ai = await summarizeWithProvider(transcriptText, correlationId);

  await updateJob(jobId, { progress: 90, step: '결과 저장 중' });

  const result = {
    jobId,
    transcript,
    summary: ai.summary,
    keyPoints: ai.keyPoints,
    actionItems: ai.actionItems,
    modelInfo: {
      provider: ai.modelInfo.provider,
      model: ai.modelInfo.model,
      promptTokens: ai.modelInfo.promptTokens,
      completionTokens: ai.modelInfo.completionTokens,
      totalTokens: ai.modelInfo.totalTokens,
      durationMs: ai.modelInfo.durationMs,
      retryCount: ai.modelInfo.retryCount
    }
  };

  await writeJson(resultPath, result);
  await updateJob(jobId, { status: 'completed', progress: 100, step: '완료' });
  logWithCorrelation('info', correlationId, 'Job completed', { jobId, modelInfo: result.modelInfo });
}

async function listJobsFor(displayName) {
  const files = await fs.readdir(JOBS_DIR);
  const jobs = [];
  for (const file of files) {
    const job = await readJson(path.join(JOBS_DIR, file));
    if (job.displayName === displayName) {
      jobs.push({
        jobId: job.jobId,
        status: job.status,
        progress: job.progress || 0,
        step: job.step || '',
        createdAt: job.createdAt,
        errorType: job.errorType,
        errorMessage: job.errorMessage,
        correlationId: job.correlationId
      });
    }
  }
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return jobs;
}

async function serveStatic(req, res, pathname) {
  const file = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(file).replace(/^\.\.(\/|\\|$)/, '');
  const fullPath = path.join(PUBLIC_DIR, safePath);
  try {
    const content = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    sendText(res, 200, content, types[ext] || 'application/octet-stream');
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'POST' && pathname === '/api/session') {
      const body = await readBody(req);
      const displayName = (body.displayName || '').trim();
      if (!displayName) return sendJson(res, 400, { error: 'displayName required' });
      const sid = id('sid');
      const session = { sessionId: sid, displayName, createdAt: now() };
      sessions.set(sid, session);
      return sendJson(res, 200, session, `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
    }

    if (pathname.startsWith('/api/')) {
      const session = getSession(req);
      if (!session) return sendJson(res, 401, { error: 'session required' });

      if (req.method === 'POST' && (pathname === '/api/jobs' || pathname === '/api/jobs/recording')) {
        const body = await readBody(req);
        try {
          const job = await createJob(session.displayName, body.fileName, body.mimeType, body.contentBase64);
          return sendJson(res, 202, { jobId: job.jobId, status: job.status, progress: job.progress, step: job.step });
        } catch (e) {
          const errorType = classifyError(e);
          const message = USER_ERROR_MESSAGES[errorType] || USER_ERROR_MESSAGES.default;
          const status = errorType === 'file_format' ? 400 : 500;
          return sendJson(res, status, { errorType, error: message });
        }
      }

      if (req.method === 'GET' && pathname === '/api/jobs') {
        const jobs = await listJobsFor(session.displayName);
        return sendJson(res, 200, jobs);
      }

      const jobStatusMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (req.method === 'GET' && jobStatusMatch) {
        const job = await readJson(path.join(JOBS_DIR, `${jobStatusMatch[1]}.json`));
        if (job.displayName !== session.displayName) return sendJson(res, 403, { error: 'forbidden' });
        return sendJson(res, 200, {
          jobId: job.jobId,
          status: job.status,
          progress: job.progress || 0,
          step: job.step || '',
          updatedAt: job.updatedAt,
          errorType: job.errorType,
          errorMessage: job.errorMessage,
          correlationId: job.correlationId
        });
      }

      const jobResultMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/result$/);
      if (req.method === 'GET' && jobResultMatch) {
        const job = await readJson(path.join(JOBS_DIR, `${jobResultMatch[1]}.json`));
        if (job.displayName !== session.displayName) return sendJson(res, 403, { error: 'forbidden' });
        if (job.status !== 'completed') return sendJson(res, 409, { error: 'job not completed' });
        const result = await readJson(path.join(RESULTS_DIR, `${jobResultMatch[1]}.json`));
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { error: 'not found' });
    }

    return serveStatic(req, res, pathname);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

ensureDirs().then(() => {
  server.listen(PORT, () => {
    console.log(`Daglo MVP server running at http://localhost:${PORT}`);
  });
});
