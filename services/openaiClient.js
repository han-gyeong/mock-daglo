const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

async function callOpenAI({ apiKey, model, prompt, correlationId, timeoutMs = 12000, maxRetries = 3 }) {
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY 또는 config/ai.config.json 의 openai.apiKey를 설정하세요.');
    err.type = 'auth';
    throw err;
  }

  const startedAt = Date.now();
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptStart = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestBody = {
        model,
        messages: [
          { role: 'system', content: '당신은 요약 도우미입니다. 반드시 JSON만 출력하세요.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2
      };

      const resp = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const error = new Error(`OpenAI API 오류: ${resp.status}`);
        error.status = resp.status;
        if (resp.status === 401 || resp.status === 403) error.type = 'auth';
        if (resp.status === 429) error.type = 'rate_limit';
        if (resp.status >= 500) error.type = 'server';

        if (isRetryableStatus(resp.status) && attempt < maxRetries) {
          const delayMs = 300 * (2 ** attempt);
          console.warn(`[${correlationId}] OpenAI retrying`, { attempt: attempt + 1, status: resp.status, delayMs });
          await wait(delayMs);
          continue;
        }

        throw error;
      }

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content || '';
      return {
        text,
        modelInfo: {
          provider: 'openai',
          model,
          promptTokens: data.usage?.prompt_tokens ?? null,
          completionTokens: data.usage?.completion_tokens ?? null,
          totalTokens: data.usage?.total_tokens ?? null,
          durationMs: Date.now() - attemptStart,
          totalDurationMs: Date.now() - startedAt,
          retryCount: attempt
        }
      };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;

      if (error.name === 'AbortError') {
        const timeoutError = new Error(`OpenAI 요청 타임아웃: ${timeoutMs}ms`);
        timeoutError.type = 'timeout';
        if (attempt < maxRetries) {
          const delayMs = 300 * (2 ** attempt);
          console.warn(`[${correlationId}] OpenAI timeout retry`, { attempt: attempt + 1, delayMs });
          await wait(delayMs);
          continue;
        }
        throw timeoutError;
      }

      if (attempt < maxRetries && isRetryableStatus(error.status)) {
        const delayMs = 300 * (2 ** attempt);
        console.warn(`[${correlationId}] OpenAI error retry`, { attempt: attempt + 1, status: error.status, delayMs });
        await wait(delayMs);
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('OpenAI 호출 실패');
}

module.exports = {
  callOpenAI
};
