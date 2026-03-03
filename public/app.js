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

async function toBase64(fileOrBlob) {
  const buffer = await fileOrBlob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

window.Daglo = { api, fmtStatus, toBase64 };
