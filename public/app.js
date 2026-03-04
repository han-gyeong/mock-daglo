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

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtTime(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function speakerStyle(speakerId = 'unknown') {
  const palette = [
    { bg: '#e8f3ff', text: '#1b64da' },
    { bg: '#e8f7ef', text: '#0d8c56' },
    { bg: '#fff3e8', text: '#bd5b00' },
    { bg: '#f2edff', text: '#5b35c9' },
    { bg: '#ffeef2', text: '#b42344' }
  ];

  const key = String(speakerId || 'unknown');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash + key.charCodeAt(i) * (i + 1)) % 997;
  return palette[hash % palette.length];
}

function toArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function renderTimeline(transcript) {
  const rows = toArray(transcript)
    .map((item) => ({
      speakerId: item?.speakerId || item?.speaker || '화자 미지정',
      startMs: Number(item?.startMs) || 0,
      endMs: Number(item?.endMs) || 0,
      text: item?.text || ''
    }))
    .filter((item) => item.text);

  if (!rows.length) return '<p class="desc">전사 데이터가 없습니다.</p>';

  const grouped = [];
  for (const row of rows) {
    const prev = grouped[grouped.length - 1];
    if (prev && prev.speakerId === row.speakerId) {
      prev.endMs = row.endMs || prev.endMs;
      prev.lines.push(row.text);
      continue;
    }

    grouped.push({
      speakerId: row.speakerId,
      startMs: row.startMs,
      endMs: row.endMs,
      lines: [row.text]
    });
  }

  return `<ol class="timeline">${grouped.map((block) => {
    const style = speakerStyle(block.speakerId);
    const speaker = escapeHtml(block.speakerId);
    const period = `${fmtTime(block.startMs)} - ${fmtTime(block.endMs || block.startMs)}`;
    const lines = block.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
    return `
      <li class="timeline-item">
        <div class="timeline-head">
          <span class="speaker-badge" style="background:${style.bg};color:${style.text};">${speaker}</span>
          <span class="mono">${period}</span>
        </div>
        <div class="timeline-body">${lines}</div>
      </li>
    `;
  }).join('')}</ol>`;
}

function renderInfoCard(title, contentHtml) {
  return `
    <article class="result-card">
      <h4>${escapeHtml(title)}</h4>
      ${contentHtml}
    </article>
  `;
}

function renderList(items, emptyText) {
  const values = toArray(items).map((item) => String(item || '').trim()).filter(Boolean);
  if (!values.length) return `<p class="desc">${escapeHtml(emptyText)}</p>`;
  return `<ul class="result-list">${values.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderResultSections(result, elements) {
  const safeResult = result || {};
  const transcriptEl = elements?.transcriptEl;
  const summaryEl = elements?.summaryEl;
  const actionsEl = elements?.actionsEl;

  if (transcriptEl) transcriptEl.innerHTML = renderTimeline(safeResult.transcript);

  if (summaryEl) {
    summaryEl.innerHTML = [
      renderInfoCard('요약', `<p>${escapeHtml(safeResult.summary || '요약 정보가 없습니다.')}</p>`),
      renderInfoCard('결정사항', renderList(safeResult.decisions, '결정사항이 없습니다.'))
    ].join('');
  }

  if (actionsEl) {
    actionsEl.innerHTML = [
      renderInfoCard('핵심 포인트', renderList(safeResult.keyPoints, '핵심 포인트가 없습니다.')),
      renderInfoCard('액션 아이템', renderList(safeResult.actionItems, '액션 아이템이 없습니다.'))
    ].join('');
  }
}

window.Daglo = { api, fmtStatus, progressHtml, toBase64, escapeHtml, renderResultSections };
