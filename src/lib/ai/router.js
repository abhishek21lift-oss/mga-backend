'use strict';
const { chatCompletion, streamCompletion } = require('./openrouter');
const { resolveModel, getFallbackModel }   = require('./models');
const logger = require('../logger');

/**
 * Non-streaming chat completion with automatic fallback routing.
 * Returns { content, usage, model, tier, intent, latency_ms, used_fallback }
 */
async function routedChat({ intent, messages, temperature, max_tokens, timeout }) {
  const { model, tier } = resolveModel(intent);

  try {
    const result = await chatCompletion({ model, messages, temperature, max_tokens, timeout });
    return { ...result, intent, tier, used_fallback: false };
  } catch (primaryErr) {
    logger.warn({ model, tier, intent, err: primaryErr.message }, 'ai_primary_failed');

    const fb = getFallbackModel(tier);
    if (!fb) throw primaryErr;

    try {
      const result = await chatCompletion({ model: fb.model, messages, temperature, max_tokens, timeout });
      logger.info({ fallback: fb.model, intent }, 'ai_fallback_success');
      return { ...result, intent, tier: fb.tier, used_fallback: true, original_error: primaryErr.message };
    } catch (fbErr) {
      logger.error({ fallback: fb.model, err: fbErr.message }, 'ai_fallback_failed');
      const final = new Error('AI service temporarily unavailable — all models failed');
      final.primary_error  = primaryErr.message;
      final.fallback_error = fbErr.message;
      final.code = 'ALL_MODELS_FAILED';
      throw final;
    }
  }
}

/**
 * Streaming chat completion with automatic fallback routing.
 * Yields SSE-ready string chunks. Returns metadata as generator return value.
 */
async function* routedStream({ intent, messages, temperature, max_tokens, timeout }) {
  const { model, tier } = resolveModel(intent);

  try {
    const gen = streamCompletion({ model, messages, temperature, max_tokens, timeout });
    for await (const chunk of gen) {
      yield chunk;
    }
    return { model, tier, intent, used_fallback: false };
  } catch (primaryErr) {
    logger.warn({ model, tier, intent, err: primaryErr.message }, 'ai_stream_primary_failed');

    const fb = getFallbackModel(tier);
    if (!fb) throw primaryErr;

    // Notify caller we're switching
    yield '\n\n[Retrying with backup model…]\n\n';

    try {
      const gen = streamCompletion({ model: fb.model, messages, temperature, max_tokens, timeout });
      for await (const chunk of gen) {
        yield chunk;
      }
      return { model: fb.model, tier: fb.tier, intent, used_fallback: true };
    } catch (fbErr) {
      logger.error({ fallback: fb.model, err: fbErr.message }, 'ai_stream_fallback_failed');
      throw new Error('AI service unavailable — all models failed');
    }
  }
}

module.exports = { routedChat, routedStream };
