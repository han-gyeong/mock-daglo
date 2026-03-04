async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

function fmtStatus(status) {
  if (status === 'completed') return '<span class="badge ok">완료</span>';
  if (status === 'failed') return '<span class="badge fail">실패</span>';
  return '<span class="badge wait">처리중</span>';
}

function progressHtml(progress = 0) {
  const safe = Math.max(0, Math.min(100, Number(progress) || 0));
  return `<div style="height:6px;background:#e9eef5;border-radius:999px;overflow:hidden;margin-top:6px;"><span style="display:block;height:100%;width:${safe}%;background:linear-gradient(90deg,#78b5ff,#3182f6)"></span></div>`;
}

async function toBase64(fileOrBlob) {
  const buffer = await fileOrBlob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function normalizeTopic(topic) {
  if (typeof topic !== 'string') return '';
  return topic.trim();
}

async function submitJob(endpoint, fileName, mimeType, blobOrFile, topic = '') {
  const contentBase64 = await toBase64(blobOrFile);
  return api(endpoint, {
    method: 'POST',
    body: JSON.stringify({ fileName, mimeType, contentBase64, topic: normalizeTopic(topic) })
  });
}

window.Daglo = { api, fmtStatus, progressHtml, toBase64, submitJob, normalizeTopic };
