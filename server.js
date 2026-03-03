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

function getSession(req) {
  const sid = parseCookies(req).sid;
  return sid ? sessions.get(sid) : null;
}

async function createJob(displayName, fileName, mimeType, contentBase64) {
  if (!contentBase64) throw new Error('contentBase64 required');
  const ext = path.extname(fileName || '') || '.webm';
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
    createdAt: now(),
    updatedAt: now()
  };

  await writeJson(path.join(JOBS_DIR, `${jobId}.json`), job);
  processJob(jobId).catch(async (e) => {
    job.status = 'failed';
    job.errorMessage = e.message;
    job.updatedAt = now();
    await writeJson(path.join(JOBS_DIR, `${jobId}.json`), job);
  });
  return job;
}

async function processJob(jobId) {
  const jobPath = path.join(JOBS_DIR, `${jobId}.json`);
  const resultPath = path.join(RESULTS_DIR, `${jobId}.json`);
  const job = await readJson(jobPath);
  job.status = 'processing';
  job.updatedAt = now();
  await writeJson(jobPath, job);

  await new Promise((r) => setTimeout(r, 1200));

  const result = {
    jobId,
    transcript: [
      { startMs: 0, endMs: 1200, text: `${job.displayName}님의 녹음 파일 전사 결과(샘플)` },
      { startMs: 1200, endMs: 3500, text: '실제 STT 연동 전까지는 데모 텍스트를 반환합니다.' }
    ],
    summary: '샘플 요약: 업로드된 음성 파일을 성공적으로 처리했습니다.',
    keyPoints: ['파일 저장 완료', '전사 결과 생성', '요약 생성'],
    actionItems: ['외부 STT API 연동', 'LLM 프롬프트 개선']
  };

  await writeJson(resultPath, result);
  job.status = 'completed';
  job.updatedAt = now();
  await writeJson(jobPath, job);
}

async function listJobsFor(displayName) {
  const files = await fs.readdir(JOBS_DIR);
  const jobs = [];
  for (const file of files) {
    const job = await readJson(path.join(JOBS_DIR, file));
    if (job.displayName === displayName) {
      jobs.push({ jobId: job.jobId, status: job.status, createdAt: job.createdAt });
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
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
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
        const job = await createJob(session.displayName, body.fileName, body.mimeType, body.contentBase64);
        return sendJson(res, 202, { jobId: job.jobId, status: job.status });
      }

      if (req.method === 'GET' && pathname === '/api/jobs') {
        const jobs = await listJobsFor(session.displayName);
        return sendJson(res, 200, jobs);
      }

      const jobStatusMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (req.method === 'GET' && jobStatusMatch) {
        const job = await readJson(path.join(JOBS_DIR, `${jobStatusMatch[1]}.json`));
        if (job.displayName !== session.displayName) return sendJson(res, 403, { error: 'forbidden' });
        return sendJson(res, 200, { jobId: job.jobId, status: job.status, updatedAt: job.updatedAt, errorMessage: job.errorMessage });
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
