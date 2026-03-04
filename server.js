const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const AI_CONFIG_PATH = path.join(ROOT, 'config', 'ai.config.json');
const SPEAKER_UNKNOWN = 'SPEAKER_UNKNOWN';

const sessions = new Map();

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }

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

async function createJob(displayName, fileName, mimeType, contentBase64, topic = '') {
  if (!contentBase64) throw new Error('contentBase64 required');
  const ext = path.extname(fileName || '') || '.webm';
  const jobId = id('job');
  const filePath = path.join(UPLOAD_DIR, `${jobId}${ext}`);
  await fs.writeFile(filePath, Buffer.from(contentBase64, 'base64'));

  const normalizedTopic = typeof topic === 'string' ? topic.trim() : '';

  const job = {
    jobId,
    displayName,
    topic: normalizedTopic,
    filePath,
    topic: String(topic || '').trim(),
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
    await updateJob(jobId, {
      status: 'failed',
      progress: 100,
      step: '실패',
      errorMessage: mapJobErrorMessage(e)
    });
  });
  return job;
}

function buildPrompt(transcript, topic = '') {
  const topicLine = topic ? `회의 주제: ${topic}` : '회의 주제: (미입력)';

  return [
    '다음 전사 텍스트를 읽고 JSON 형식으로만 답해줘.',
    '{"summary":"...","keyPoints":["..."],"actionItems":["..."]}',
    '각 배열은 최대 3개 항목으로 짧게 작성해줘.',
    topicLine,
    '전사:',
    transcript
  ].join('\n');
}

function parseAiJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI 응답 JSON 파싱 실패');
  return JSON.parse(match[0]);
}

async function callOpenAI(config, prompt) {
  if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY 또는 config/ai.config.json 의 openai.apiKey를 설정하세요.');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openai.apiKey}`
    },
    body: JSON.stringify({
      model: config.openai.model,
      messages: [
        { role: 'system', content: '당신은 요약 도우미입니다. 반드시 JSON만 출력하세요.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    })
  });

  if (!resp.ok) throw new Error(`OpenAI API 오류: ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function rerankSegmentWithOpenAI(config, segment, topicHints) {
  const candidates = [segment.text, ...(segment.alternatives || [])].filter(Boolean).slice(0, 5);
  if (candidates.length === 0) return segment.text;

  const prompt = [
    '다음 STT 후보 중 문맥과 topic hints에 가장 맞는 문장을 1개 고르세요.',
    '반드시 JSON 형식으로만 답하고 key는 finalText 하나만 사용하세요.',
    `topic hints: ${topicHints.join(', ') || '(없음)'}`,
    `candidates: ${JSON.stringify(candidates)}`
  ].join('\n');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openai.apiKey}`
    },
    body: JSON.stringify({
      model: config.openai.model,
      messages: [
        { role: 'system', content: '당신은 STT 재정렬 도우미입니다. JSON만 반환하세요.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0
    })
  });

  if (!resp.ok) throw new Error(`OpenAI rerank API 오류: ${resp.status}`);
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = parseAiJson(content);
  return String(parsed.finalText || segment.text).trim() || segment.text;
}

async function callGemini(config, prompt) {
  if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY 또는 config/ai.config.json 의 gemini.apiKey를 설정하세요.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    })
  });

  if (!resp.ok) throw new Error(`Gemini API 오류: ${resp.status}`);
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function summarizeWithProvider(transcript, topic = '') {
  const config = await loadAiConfig();
  const prompt = buildPrompt(transcript, topic);
  const provider = (config.provider || '').toLowerCase();

  let text;
  if (provider === 'openai') text = await callOpenAI(config, prompt);
  else if (provider === 'gemini') text = await callGemini(config, prompt);
  else throw new Error(`지원하지 않는 provider: ${config.provider}`);

  const parsed = parseAiJson(text);
  return {
    provider,
    model: provider === 'openai' ? config.openai.model : config.gemini.model,
    summary: parsed.summary || '',
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 3) : [],
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.slice(0, 3) : []
  };
}

async function runStt(filePath, displayName) {
  await new Promise((r) => setTimeout(r, 800));
  return [
    { startMs: 0, endMs: 1200, text: `${displayName}님의 녹음 파일 전사 결과(샘플)` },
    { startMs: 1200, endMs: 3500, text: '실제 STT 연동 전까지는 데모 텍스트를 반환합니다.' }
  ];
}

async function runDiarization(filePath) {
  const fileStat = await fs.stat(filePath);
  if (!fileStat.size) throw new Error('빈 오디오 파일은 화자 분리를 수행할 수 없습니다.');

  return [
    { startMs: 0, endMs: 1700, speakerId: 'SPEAKER_01' },
    { startMs: 1700, endMs: 3500, speakerId: 'SPEAKER_02' }
  ];
}

function overlapDuration(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function mergeTranscriptWithSpeakers(transcriptSegments, diarizationSegments) {
  return transcriptSegments.map((segment) => {
    let assignedSpeaker = SPEAKER_UNKNOWN;
    let maxOverlap = 0;

    for (const diarization of diarizationSegments) {
      const overlap = overlapDuration(segment.startMs, segment.endMs, diarization.startMs, diarization.endMs);
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        assignedSpeaker = diarization.speakerId || SPEAKER_UNKNOWN;
      }
    }

    return {
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      speakerId: maxOverlap > 0 ? assignedSpeaker : SPEAKER_UNKNOWN
    };
  });
}

async function processJob(jobId) {
  const resultPath = path.join(RESULTS_DIR, `${jobId}.json`);
  const baseJob = await updateJob(jobId, { status: 'processing', progress: 15, step: 'STT 처리 중' });
  const sttTranscript = await transcribeAudioWithOpenAI(baseJob.filePath, baseJob.mimeType);

  const transcript = await runStt(baseJob.filePath, baseJob.displayName);
  await updateJob(jobId, { progress: 40, step: '화자 분리 처리 중' });

  let mergedTranscript;
  let diarization = [];
  let diarizationStatus = { attempted: true, success: false, errorMessage: null };

  try {
    diarization = await runDiarization(baseJob.filePath);
    mergedTranscript = mergeTranscriptWithSpeakers(transcript, diarization);
    diarizationStatus.success = true;
  } catch (error) {
    mergedTranscript = mergeTranscriptWithSpeakers(transcript, []);
    diarizationStatus.errorMessage = error.message;
  }

  const transcriptTopicSuffix = baseJob.topic ? ` · 주제: ${baseJob.topic}` : '';
  const transcript = [
    { startMs: 0, endMs: 1200, text: `${baseJob.displayName}님의 녹음 파일 전사 결과(샘플)${transcriptTopicSuffix}` },
    { startMs: 1200, endMs: 3500, text: '실제 STT 연동 전까지는 데모 텍스트를 반환합니다.' }
  ];

  const topicHints = buildTopicHints(baseJob.topic);
  let ambiguityResolvedCount = 0;
  let topicBiasApplied = false;

  if (topicHints.length > 0) {
    topicBiasApplied = true;
    const config = await loadAiConfig();
    const ambiguousSegments = collectAmbiguousSegments(transcript);
    if (config.openai.apiKey) {
      for (const segment of ambiguousSegments) {
        const reranked = await rerankSegmentWithOpenAI(config, segment, topicHints);
        if (reranked && reranked !== transcript[segment.index].text) {
          transcript[segment.index].text = reranked;
          ambiguityResolvedCount += 1;
        }
      }
    }
  }

  await updateJob(jobId, { progress: 55, step: '요약 생성 중(AI)' });

  const transcriptText = transcript.map((v) => v.text).join('\n');
  const ai = await summarizeWithProvider(transcriptText, baseJob.topic);

  await updateJob(jobId, { progress: 90, step: '결과 저장 중' });

  const result = {
    jobId,
    transcript: mergedTranscript,
    diarization,
    transcriptSchemaVersion: '1.0.0',
    speakerUnknownLabel: SPEAKER_UNKNOWN,
    diarizationStatus,
    summary: ai.summary,
    keyPoints: ai.keyPoints,
    actionItems: ai.actionItems,
    modelInfo: { provider: ai.provider, model: ai.model },
    meta: {
      ambiguityResolvedCount,
      appliedTopicHints: topicHints,
      topicBiasApplied
    }
  };

  await writeJson(resultPath, result);
  await updateJob(jobId, { status: 'completed', progress: 100, step: '완료' });
}

async function listJobsFor(displayName) {
  const files = await fs.readdir(JOBS_DIR);
  const jobs = [];
  for (const file of files) {
    const job = await readJson(path.join(JOBS_DIR, file));
    if (job.displayName === displayName) {
      jobs.push({ jobId: job.jobId, status: job.status, progress: job.progress || 0, step: job.step || '', createdAt: job.createdAt });
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
        const job = await createJob(session.displayName, body.fileName, body.mimeType, body.contentBase64, body.topic);
        return sendJson(res, 202, { jobId: job.jobId, status: job.status, progress: job.progress, step: job.step });
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
          topic: typeof job.topic === 'string' ? job.topic : undefined,
          updatedAt: job.updatedAt,
          errorMessage: job.errorMessage
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
