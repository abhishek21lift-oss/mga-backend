'use strict';
const logger = require('../logger');

const BASE_URL     = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS   = 90_000;
const SITE_URL     = process.env.FRONTEND_URL || 'https://619fitness.app';
const SITE_NAME    = 'MY PT STUDIO';

function getApiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    const err = new Error('OPENROUTER_API_KEY is not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return key;
}

function buildHeaders() {
  return {
    'Authorization':  `Bearer ${getApiKey()}`,
    'Content-Type':   'application/json',
    'HTTP-Referer':   SITE_URL,
    'X-Title':        SITE_NAME,
  };
}

/**
 * Non-streaming chat completion.
 * Returns { content, usage, model, latency_ms }
 */
async function chatCompletion({ model, messages, temperature = 0.7, max_tokens = 2048, timeout = TIMEOUT_MS }) {
  const start      = Date.now();
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ model, messages, temperature, max_tokens }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err  = new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      err.body   = text;
      throw err;
    }

    // Keep the abort timer alive through body read — free-tier models can be
    // slow to stream the full response body after sending headers.
    const data     = await res.json();
    clearTimeout(timer);

    const content  = data.choices?.[0]?.message?.content ?? '';
    const usage    = data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const latency  = Date.now() - start;

    logger.info({ model, latency_ms: latency, tokens: usage.total_tokens }, 'ai_completion_ok');
    return { content, usage, model: data.model || model, latency_ms: latency };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError' || err.message === 'This operation was aborted.' ||
        err.message === 'Load failed') {
      const elapsed = Date.now() - start;
      const t = new Error(`OpenRouter request timed out after ${elapsed}ms`);
      t.code = 'TIMEOUT';
      throw t;
    }
    throw err;
  }
}

/**
 * Streaming chat completion — yields text delta strings.
 * Returns { usage } after the stream is exhausted.
 */
async function* streamCompletion({ model, messages, temperature = 0.7, max_tokens = 2048, timeout = TIMEOUT_MS }) {
  const start      = Date.now();
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ model, messages, temperature, max_tokens, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      const t = new Error(`Stream timed out after ${timeout}ms`);
      t.code = 'TIMEOUT';
      throw t;
    }
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    const err  = new Error(`OpenRouter stream ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';
  let usage     = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) usage = parsed.usage;
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch { /* skip malformed chunk */ }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    logger.info({ model, latency_ms: Date.now() - start }, 'ai_stream_done');
  }

  return usage;
}

/**
 * Quick model health check — 1-token completion.
 */
async function pingModel(model) {
  const start = Date.now();
  try {
    await chatCompletion({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      timeout: 30_000,
    });
    return { model, status: 'ok', latency_ms: Date.now() - start };
  } catch (err) {
    return { model, status: 'error', error: err.message, latency_ms: Date.now() - start };
  }
}

module.exports = { chatCompletion, streamCompletion, pingModel };
