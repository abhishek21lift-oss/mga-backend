'use strict';
// src/routes/ai.js — Multi-model AI routes for MY PT STUDIO
// All models are resolved from env vars; no hardcoded model names here.

const express    = require('express');
const pool       = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');
const logger     = require('../lib/logger');

// Null-safe tenant param: a tenant user gets their org id (queries then filter
// `organization_id = $x`); a platform super admin operating platform-wide gets
// NULL, and `$x IS NULL OR organization_id = $x` matches every row. A super
// admin targeting one org via x-org-id gets that org id and is filtered.
function orgParam(req) {
  const scope = tenantScope(req);
  return scope.applyFilter ? scope.orgId : null;
}
const { routedChat, routedStream }     = require('../lib/ai/router');
const { pingModel }                    = require('../lib/ai/openrouter');
const { models }                       = require('../lib/ai/models');
const { logUsage, getUserUsage, getModelStats } = require('../lib/ai/usage');
const { retrieveContext }              = require('../lib/ai/knowledgeBase');
const { runTools }                     = require('../lib/ai/tools');
const {
  buildCoachSystemPrompt,
  buildWorkoutSystemPrompt,
  buildDietSystemPrompt,
  buildProgressSystemPrompt,
  buildFitnessTestingSystemPrompt,
  buildBusinessSystemPrompt,
} = require('../lib/ai/prompts/system');

const router = express.Router();

/* ─── Guard ─────────────────────────────────────────────────────────────── */
function requireConfigured(req, res, next) {
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(501).json({
      error: 'AI not configured',
      message: 'OPENROUTER_API_KEY is not set in environment variables.',
    });
  }
  next();
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */
const { extractJson } = require('../lib/ai/jsonExtract');

// Tenant isolation: `org` is the caller's org id (null for a platform super
// admin operating platform-wide). The parent pt_clients lookup is org-scoped,
// so a client_id belonging to another tenant yields no row and the function
// returns '' — the child goal/assessment/check-in rows (all keyed by that
// client_id) are only ever read into the context after that in-org check.
async function buildClientContext(client_id, org) {
  if (!client_id) return '';
  try {
    const [clientRes, goalsRes, assessRes, checkinsRes] = await Promise.all([
      pool.query('SELECT name, dob, gender, mobile FROM pt_clients WHERE id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR organization_id=$2)', [client_id, org]),
      pool.query('SELECT goal_type, target_weight, target_body_fat, notes FROM pt_goals WHERE client_id=$1 AND is_active=true LIMIT 3', [client_id]),
      pool.query('SELECT weight, body_fat_pct, chest_cm, waist_cm, hips_cm, created_at FROM pt_assessments WHERE client_id=$1 ORDER BY created_at DESC LIMIT 2', [client_id]),
      pool.query('SELECT weight, mood, sleep_hours, client_notes, created_at FROM weekly_checkins WHERE client_id=$1 ORDER BY created_at DESC LIMIT 4', [client_id]),
    ]);

    const c      = clientRes.rows[0];
    if (!c) return '';
    const age    = c.dob ? Math.floor((Date.now() - new Date(c.dob).getTime()) / 31557600000) : null;
    const latest = assessRes.rows[0] || {};

    const lines = [
      `Name: ${c.name}`,
      age ? `Age: ${age}` : '',
      c.gender ? `Gender: ${c.gender}` : '',
      latest.weight ? `Current weight: ${latest.weight} kg` : '',
      latest.body_fat_pct ? `Body fat: ${latest.body_fat_pct}%` : '',
    ];

    if (goalsRes.rows.length) {
      lines.push(`Goals: ${goalsRes.rows.map(g => {
        const target = g.target_weight ? `${g.target_weight} kg` : g.target_body_fat ? `${g.target_body_fat}% body fat` : 'no specific target';
        return `${g.goal_type} — ${target}`;
      }).join(', ')}`);
    }
    if (checkinsRes.rows.length) {
      const last = checkinsRes.rows[0];
      lines.push(`Last weekly check-in: weight ${last.weight || 'N/A'} kg, mood ${last.mood || 'N/A'}, sleep ${last.sleep_hours || 'N/A'}h`);
    }

    return lines.filter(Boolean).join('\n');
  } catch (err) {
    logger.warn({ err: err.message }, 'ai_context_build_failed');
    return '';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. AI COACH CHAT  (SSE streaming)
   POST /api/ai/chat
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/chat', auth, requireConfigured, async (req, res) => {
  const { message, conversation_id, client_id, regenerate } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
  // Regenerate only makes sense against an existing thread — without one
  // there is no previous answer to replace, so it degrades to a normal send.
  const isRegenerate = Boolean(regenerate) && Boolean(conversation_id);

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    // Resolve or create conversation
    let convId = conversation_id;
    if (!convId) {
      const title = message.slice(0, 60).trim();
      const { rows } = await pool.query(
        `INSERT INTO ai_conversations (user_id, client_id, title) VALUES ($1,$2,$3) RETURNING id`,
        [req.user.id, client_id || null, title]
      );
      convId = rows[0].id;
    }

    if (isRegenerate) {
      // "Try again" on the last answer. The user's question is already in the
      // thread, so re-inserting it would leave the same question stored twice
      // and shown twice. Instead drop the previous answer, leaving history
      // ending on that question — the model then answers it afresh, and the
      // new reply is appended below exactly like a first attempt.
      await pool.query(
        `DELETE FROM ai_messages WHERE id = (
           SELECT id FROM ai_messages
           WHERE conversation_id = $1 AND role = 'assistant'
           ORDER BY created_at DESC LIMIT 1)`,
        [convId]
      );
    } else {
      await pool.query(
        `INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,'user',$2)`,
        [convId, message]
      );
    }

    // Build conversation history (last 20 messages)
    const histRes = await pool.query(
      `SELECT role, content FROM ai_messages WHERE conversation_id=$1 ORDER BY created_at ASC`,
      [convId]
    );

    // Build system prompt with optional client context (org-scoped)
    const clientCtx = await buildClientContext(client_id, orgParam(req));

    // RAG: ground the answer in this studio's own uploaded SOPs/guides/
    // policies before falling back to the model's general knowledge.
    // Retrieval failures (e.g. embedding model not yet warmed up) are
    // non-fatal — the coach still answers, just without citations.
    let knowledgeChunks = [];
    try {
      knowledgeChunks = await retrieveContext({ organizationId: orgParam(req), query: message });
    } catch (ragErr) {
      logger.warn({ err: ragErr.message }, 'ai_chat_rag_retrieval_failed');
    }
    const knowledgeCtx = knowledgeChunks
      .map((c, i) => `[${i + 1}] (${c.title}) ${c.content}`)
      .join('\n\n');

    // Tool-calling: pattern-match the message against this studio's own live
    // data (members, attendance, revenue, dues, trainers, exercises) — see
    // lib/ai/tools.js for why this is app-layer routing rather than
    // model-driven function calling. Non-fatal on failure, same as RAG above.
    let toolNames = [];
    let toolCtx = '';
    try {
      const toolResult = await runTools(req, message);
      toolNames = toolResult.toolNames;
      toolCtx = toolResult.contextText;
    } catch (toolErr) {
      logger.warn({ err: toolErr.message }, 'ai_chat_tools_failed');
    }

    const systemPrompt = buildCoachSystemPrompt(clientCtx, knowledgeCtx, toolCtx);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...histRes.rows.map(r => ({ role: r.role, content: r.content })),
    ];

    send({ type: 'start', conversation_id: convId });
    if (knowledgeChunks.length) {
      // De-duplicated document titles, in relevance order — lets the UI show
      // "Answered using: <titles>" without exposing raw chunk text or ids.
      const sources = [...new Set(knowledgeChunks.map((c) => c.title))];
      send({ type: 'sources', sources });
    }
    if (toolNames.length) {
      send({ type: 'tools', tools: toolNames });
    }

    // Stream response
    let fullContent  = '';
    const { model: routedModel } = (() => {
      const { resolveModel } = require('../lib/ai/models');
      return resolveModel('chat');
    })();

    try {
      const gen = routedStream({ intent: 'chat', messages, temperature: 0.75, max_tokens: 1024 });
      for await (const chunk of gen) {
        fullContent += chunk;
        send({ type: 'chunk', content: chunk });
      }
    } catch (streamErr) {
      send({ type: 'error', message: streamErr.message });
      res.end();
      return;
    }

    // Save assistant message
    await pool.query(
      `INSERT INTO ai_messages (conversation_id, role, content, provider) VALUES ($1,'assistant',$2,'openrouter')`,
      [convId, fullContent]
    );

    // Update conversation timestamp
    await pool.query(`UPDATE ai_conversations SET updated_at=NOW() WHERE id=$1`, [convId]);

    // Log usage (best-effort)
    await logUsage({
      user_id:         req.user.id,
      conversation_id: convId,
      model:           routedModel,
      intent_type:     'chat',
      tokens_prompt:   0,
      tokens_completion: Math.ceil(fullContent.length / 4),
    });

    send({ type: 'done', conversation_id: convId });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_chat_error');
    send({ type: 'error', message: err.message || 'AI request failed' });
  } finally {
    res.end();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. WORKOUT PLAN GENERATOR  (SSE streaming — bypasses Render 30s timeout)
   POST /api/ai/workout/generate
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/workout/generate', auth, requireConfigured, async (req, res) => {
  const {
    age, gender, weight_kg, height_cm, goal, experience_level,
    injuries = 'none', equipment = 'full gym', training_days = 4,
    duration_weeks = 8,
  } = req.body || {};

  const required = { age, gender, weight_kg, height_cm, goal, experience_level };
  const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  const userPrompt = `Generate a ${duration_weeks}-week workout plan for the following client:
- Age: ${age}
- Gender: ${gender}
- Weight: ${weight_kg} kg
- Height: ${height_cm} cm
- Goal: ${goal}
- Experience level: ${experience_level}
- Injuries / limitations: ${injuries}
- Available equipment: ${equipment}
- Training days per week: ${training_days}

Create a complete progressive programme with warm-up, cool-down, and progression strategy.`;

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    const trainerName = req.user?.name || '';
    let fullContent = '';
    let streamMeta  = { model: models.primary, tier: 'primary', used_fallback: false };

    const it = routedStream({
      intent:      'workout',
      messages:    [
        { role: 'system', content: buildWorkoutSystemPrompt(trainerName) },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.6,
      max_tokens:  8000,
    })[Symbol.asyncIterator]();

    let step;
    while (!(step = await it.next()).done) {
      if (typeof step.value === 'string') {
        if (step.value.startsWith('\n\n[Retrying')) {
          // Fallback retry: discard the failed primary model's partial
          // output — keeping it left two half-responses concatenated,
          // which could never parse as JSON.
          fullContent = '';
        } else {
          fullContent += step.value;
        }
      }
      res.write(': ping\n\n'); // keeps Render connection alive
    }
    if (step.value && typeof step.value === 'object') streamMeta = step.value;

    const plan = extractJson(fullContent);
    if (!plan) {
      send({ type: 'error', message: 'Could not parse AI response as JSON' });
      res.end();
      return;
    }

    logUsage({
      user_id:           req.user.id,
      model:             streamMeta.model,
      intent_type:       'workout',
      tokens_prompt:     0,
      tokens_completion: Math.ceil(fullContent.length / 4),
      used_fallback:     streamMeta.used_fallback,
    }).catch(() => {});

    send({ type: 'done', data: plan, model: streamMeta.model, tier: streamMeta.tier, used_fallback: streamMeta.used_fallback });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_workout_generate_error');
    send({ type: 'error', message: err.code === 'NOT_CONFIGURED' ? err.message : 'AI workout generation failed. Please try again.' });
  } finally {
    res.end();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. DIET / NUTRITION PLAN GENERATOR  (SSE streaming)
   POST /api/ai/diet/generate
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/diet/generate', auth, requireConfigured, async (req, res) => {
  const {
    age, gender, weight_kg, height_cm, activity_level, goal,
    dietary_preferences = 'none', allergies = 'none',
    budget = 'medium', meal_frequency = 4,
  } = req.body || {};

  const required = { age, gender, weight_kg, height_cm, activity_level, goal };
  const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  const userPrompt = `Generate a personalised nutrition plan for the following client:
- Age: ${age}
- Gender: ${gender}
- Weight: ${weight_kg} kg
- Height: ${height_cm} cm
- Activity level: ${activity_level}
- Goal: ${goal}
- Dietary preferences: ${dietary_preferences}
- Allergies / intolerances: ${allergies}
- Budget: ${budget}
- Preferred meals per day: ${meal_frequency}

Calculate accurate TDEE, set appropriate calorie and macro targets, then create a practical meal plan with grocery list and supplement stack.`;

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    const trainerName = req.user?.name || '';
    let fullContent = '';
    let streamMeta  = { model: models.primary, tier: 'primary', used_fallback: false };

    const it = routedStream({
      intent:      'diet',
      messages:    [
        { role: 'system', content: buildDietSystemPrompt(trainerName) },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.5,
      // Higher than workout's 8000: the diet schema nests a full macro
      // breakdown per FOOD ITEM inside every meal, plus a grocery list and
      // supplement stack after that — considerably more tokens to fully
      // complete than the workout schedule, and the most common cause of
      // the "Could not parse AI response as JSON" failure was simply running
      // out of budget mid-object before ever reaching the closing brace.
      max_tokens:  14000,
    })[Symbol.asyncIterator]();

    let step;
    while (!(step = await it.next()).done) {
      if (typeof step.value === 'string') {
        if (step.value.startsWith('\n\n[Retrying')) {
          // Fallback retry: discard the failed primary model's partial
          // output — keeping it left two half-responses concatenated,
          // which could never parse as JSON.
          fullContent = '';
        } else {
          fullContent += step.value;
        }
      }
      res.write(': ping\n\n');
    }
    if (step.value && typeof step.value === 'object') streamMeta = step.value;

    const plan = extractJson(fullContent);
    if (!plan) {
      send({ type: 'error', message: 'Could not parse AI response as JSON' });
      res.end();
      return;
    }

    logUsage({
      user_id:           req.user.id,
      model:             streamMeta.model,
      intent_type:       'diet',
      tokens_prompt:     0,
      tokens_completion: Math.ceil(fullContent.length / 4),
      used_fallback:     streamMeta.used_fallback,
    }).catch(() => {});

    send({ type: 'done', data: plan, model: streamMeta.model, tier: streamMeta.tier, used_fallback: streamMeta.used_fallback });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_diet_generate_error');
    send({ type: 'error', message: err.code === 'NOT_CONFIGURED' ? err.message : 'AI diet generation failed. Please try again.' });
  } finally {
    res.end();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. PROGRESS ANALYSER
   POST /api/ai/progress/analyze
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/progress/analyze', auth, requireConfigured, async (req, res) => {
  const { client_id } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  try {
    // Tenant isolation: verify the client belongs to the caller's org before
    // reading any of their progress data. A wrong-org client_id yields no
    // parent row → 404 below, and the child queries (keyed by client_id) are
    // never surfaced.
    const org = orgParam(req);
    // Fetch all progress data for this client
    const [clientRes, assessRes, goalsRes, checkinsRes, strengthRes, attRes, photosRes] = await Promise.all([
      pool.query('SELECT name, dob, gender, pt_start_date FROM pt_clients WHERE id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR organization_id=$2)', [client_id, org]),
      pool.query('SELECT weight, body_fat_pct, chest_cm, waist_cm, hips_cm, thigh_right_cm, thigh_left_cm, arm_right_cm, arm_left_cm, bmi, created_at FROM pt_assessments WHERE client_id=$1 ORDER BY created_at ASC', [client_id]),
      pool.query('SELECT goal_type, target_weight, target_body_fat, is_active, created_at FROM pt_goals WHERE client_id=$1 ORDER BY created_at DESC LIMIT 5', [client_id]),
      pool.query('SELECT weight, mood, sleep_hours, water_glasses, client_notes, created_at FROM weekly_checkins WHERE client_id=$1 ORDER BY created_at ASC', [client_id]),
      pool.query('SELECT exercise_name, weight_kg, reps_done, created_at FROM strength_logs WHERE client_id=$1 ORDER BY created_at ASC', [client_id]),
      pool.query(`SELECT COUNT(*) AS total_sessions, COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '30 days') AS sessions_30d FROM pt_sessions WHERE client_id=$1`, [client_id]),
      pool.query('SELECT COUNT(*) AS total_photos FROM progress_photos WHERE client_id=$1', [client_id]),
    ]);

    const client = clientRes.rows[0];
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const age = client.dob ? Math.floor((Date.now() - new Date(client.dob).getTime()) / 31557600000) : null;
    const daysSinceStart = client.pt_start_date ? Math.floor((Date.now() - new Date(client.pt_start_date).getTime()) / 86400000) : null;

    const contextData = {
      client: {
        name: client.name,
        age,
        gender: client.gender,
        days_since_start: daysSinceStart,
      },
      assessments:  assessRes.rows,
      goals:        goalsRes.rows,
      weekly_checkins: checkinsRes.rows,
      strength_logs: strengthRes.rows,
      attendance:   attRes.rows[0],
      progress_photos: { total: photosRes.rows[0]?.total_photos || 0 },
    };

    const userPrompt = `Analyse the following client progress data and generate a comprehensive report:\n\n${JSON.stringify(contextData, null, 2)}`;

    // Switch to SSE before the slow AI call
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

    let fullContent = '';
    let streamMeta  = { model: models.primary, tier: 'primary', used_fallback: false };

    const it = routedStream({
      intent:      'progress',
      messages:    [
        { role: 'system', content: buildProgressSystemPrompt() },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens:  4000,
    })[Symbol.asyncIterator]();

    let step;
    while (!(step = await it.next()).done) {
      if (typeof step.value === 'string') {
        if (step.value.startsWith('\n\n[Retrying')) {
          // Fallback retry: discard the failed primary model's partial
          // output — keeping it left two half-responses concatenated,
          // which could never parse as JSON.
          fullContent = '';
        } else {
          fullContent += step.value;
        }
      }
      res.write(': ping\n\n');
    }
    if (step.value && typeof step.value === 'object') streamMeta = step.value;

    const analysis = extractJson(fullContent);
    if (!analysis) {
      send({ type: 'error', message: 'Could not parse AI response' });
      res.end();
      return;
    }

    logUsage({
      user_id:           req.user.id,
      model:             streamMeta.model,
      intent_type:       'progress',
      tokens_prompt:     0,
      tokens_completion: Math.ceil(fullContent.length / 4),
      used_fallback:     streamMeta.used_fallback,
    }).catch(() => {});

    send({ type: 'done', data: analysis, model: streamMeta.model, tier: streamMeta.tier, used_fallback: streamMeta.used_fallback });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_progress_analyze_error');
    // Headers may or may not have been sent yet depending on where the error occurred
    if (!res.headersSent) {
      if (err.code === 'NOT_CONFIGURED') return res.status(501).json({ error: err.message });
      return res.status(503).json({ error: 'Progress analysis failed', message: err.message });
    }
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.code === 'NOT_CONFIGURED' ? err.message : 'Progress analysis failed. Please try again.' })}\n\n`);
    } catch { /* ignore write errors on closed connection */ }
  } finally {
    try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. FITNESS TESTING ANALYSER
   POST /api/ai/fitness-testing/analyze
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/fitness-testing/analyze', auth, requireConfigured, async (req, res) => {
  const { assessment_id } = req.body || {};
  if (!assessment_id) return res.status(400).json({ error: 'assessment_id is required' });

  try {
    // Tenant isolation: the assessment must belong to the caller's org. A
    // wrong-org assessment_id yields no row → 404, so neither the assessment
    // nor the client it points at can be read across tenants.
    const org = orgParam(req);
    const { rows: assessRows } = await pool.query('SELECT * FROM pt_assessments WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)', [assessment_id, org]);
    const assessment = assessRows[0];
    if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

    const [clientRes, previousRes] = await Promise.all([
      pool.query('SELECT name, dob, gender FROM pt_clients WHERE id=$1 AND deleted_at IS NULL', [assessment.client_id]),
      pool.query(
        'SELECT * FROM pt_assessments WHERE client_id=$1 AND assessment_date < $2 ORDER BY assessment_date DESC LIMIT 1',
        [assessment.client_id, assessment.assessment_date]
      ),
    ]);

    const client = clientRes.rows[0];
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const age = client.dob ? Math.floor((Date.now() - new Date(client.dob).getTime()) / 31557600000) : null;

    const contextData = {
      client: { name: client.name, age, gender: client.gender },
      current_assessment: assessment,
      previous_assessment: previousRes.rows[0] || null,
    };

    const userPrompt = `Analyse the following fitness assessment and generate a structured report:\n\n${JSON.stringify(contextData, null, 2)}`;

    // Switch to SSE before the slow AI call
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

    let fullContent = '';
    let streamMeta  = { model: models.primary, tier: 'primary', used_fallback: false };

    const it = routedStream({
      intent:      'assessment',
      messages:    [
        { role: 'system', content: buildFitnessTestingSystemPrompt() },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens:  4000,
    })[Symbol.asyncIterator]();

    let step;
    while (!(step = await it.next()).done) {
      if (typeof step.value === 'string') {
        if (step.value.startsWith('\n\n[Retrying')) {
          // Fallback retry: discard the failed primary model's partial
          // output — keeping it left two half-responses concatenated,
          // which could never parse as JSON.
          fullContent = '';
        } else {
          fullContent += step.value;
        }
      }
      res.write(': ping\n\n');
    }
    if (step.value && typeof step.value === 'object') streamMeta = step.value;

    const analysis = extractJson(fullContent);
    if (!analysis) {
      send({ type: 'error', message: 'Could not parse AI response' });
      res.end();
      return;
    }

    logUsage({
      user_id:           req.user.id,
      model:             streamMeta.model,
      intent_type:       'fitness_testing',
      tokens_prompt:     0,
      tokens_completion: Math.ceil(fullContent.length / 4),
      used_fallback:     streamMeta.used_fallback,
    }).catch(() => {});

    send({ type: 'done', data: analysis, model: streamMeta.model, tier: streamMeta.tier, used_fallback: streamMeta.used_fallback });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_fitness_testing_analyze_error');
    // Headers may or may not have been sent yet depending on where the error occurred
    if (!res.headersSent) {
      if (err.code === 'NOT_CONFIGURED') return res.status(501).json({ error: err.message });
      return res.status(503).json({ error: 'Fitness testing analysis failed', message: err.message });
    }
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.code === 'NOT_CONFIGURED' ? err.message : 'Fitness testing analysis failed. Please try again.' })}\n\n`);
    } catch { /* ignore write errors on closed connection */ }
  } finally {
    try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. BUSINESS INSIGHTS  (admin only)
   POST /api/ai/business/insights
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/business/insights', auth, requireConfigured, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { from, to } = req.body || {};
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const toDate   = to   ? new Date(to)   : new Date();

  try {
    // Tenant isolation: an org admin sees only their own gym's business data;
    // a platform super admin operating platform-wide ($3/$1 = NULL) sees all.
    // pt_client_renewals has no organization_id, so it is scoped via a join to
    // its client's org (LEFT JOIN so a super admin still counts orphan rows).
    const org = orgParam(req);
    const [revenueRes, membersRes, sessionsRes, trainersRes, renewalsRes, duesRes] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(amount),0) AS total_revenue,
           COUNT(*)                AS total_payments
         FROM pt_payments WHERE date BETWEEN $1 AND $2 AND deleted_at IS NULL
           AND ($3::uuid IS NULL OR organization_id = $3)`,
        [fromDate, toDate, org]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='active')   AS active_members,
           COUNT(*) FILTER (WHERE status='inactive') AS inactive_members,
           COUNT(*) FILTER (WHERE pt_start_date BETWEEN $1 AND $2) AS new_members_period
         FROM pt_clients WHERE deleted_at IS NULL
           AND ($3::uuid IS NULL OR organization_id = $3)`,
        [fromDate, toDate, org]
      ),
      pool.query(
        `SELECT COUNT(*) AS total_sessions,
                COUNT(DISTINCT client_id) AS active_clients
         FROM pt_sessions WHERE session_date BETWEEN $1 AND $2
           AND ($3::uuid IS NULL OR organization_id = $3)`,
        [fromDate, toDate, org]
      ),
      pool.query(
        `SELECT t.name AS trainer_name,
                COUNT(s.id) AS sessions,
                COALESCE(SUM(p.amount),0) AS revenue
         FROM trainers t
         LEFT JOIN pt_sessions s ON s.trainer_id=t.id AND s.session_date BETWEEN $1 AND $2
         LEFT JOIN pt_payments p ON p.trainer_id=t.id AND p.date BETWEEN $1 AND $2 AND p.deleted_at IS NULL
         WHERE t.deleted_at IS NULL
           AND ($3::uuid IS NULL OR t.organization_id = $3)
         GROUP BY t.id, t.name ORDER BY revenue DESC`,
        [fromDate, toDate, org]
      ),
      pool.query(
        `SELECT COUNT(*) AS total_renewals,
                COALESCE(SUM(r.paid_amount),0) AS renewal_revenue
         FROM pt_client_renewals r
         LEFT JOIN pt_clients c ON c.id = r.client_id
         WHERE r.renewed_at BETWEEN $1 AND $2
           AND ($3::uuid IS NULL OR c.organization_id = $3)`,
        [fromDate, toDate, org]
      ),
      pool.query(
        `SELECT COUNT(*) AS clients_with_dues,
                COALESCE(SUM(balance_amount) FILTER (WHERE balance_amount > 0),0) AS total_dues
         FROM pt_clients WHERE deleted_at IS NULL AND balance_amount > 0
           AND ($1::uuid IS NULL OR organization_id = $1)`,
        [org]
      ),
    ]);

    const bizData = {
      period: { from: fromDate.toISOString().slice(0,10), to: toDate.toISOString().slice(0,10) },
      revenue:  revenueRes.rows[0],
      members:  membersRes.rows[0],
      sessions: sessionsRes.rows[0],
      trainers: trainersRes.rows,
      renewals: renewalsRes.rows[0],
      outstanding_dues: duesRes.rows[0],
    };

    const userPrompt = `Analyse the following gym business data and generate an executive insights report:\n\n${JSON.stringify(bizData, null, 2)}`;

    const result = await routedChat({
      intent:      'business',
      messages:    [
        { role: 'system', content: buildBusinessSystemPrompt() },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens:  8000,
    });

    const insights = extractJson(result.content);
    if (!insights) {
      return res.status(422).json({ error: 'Could not parse AI response', raw: result.content.slice(0, 500) });
    }

    await logUsage({
      user_id:           req.user.id,
      model:             result.model,
      intent_type:       'business',
      tokens_prompt:     result.usage?.prompt_tokens     || 0,
      tokens_completion: result.usage?.completion_tokens || 0,
      latency_ms:        result.latency_ms,
      used_fallback:     result.used_fallback,
    });

    res.json({ data: insights, raw_data: bizData, model: result.model, tier: result.tier, used_fallback: result.used_fallback });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_business_insights_error');
    if (err.code === 'NOT_CONFIGURED') return res.status(501).json({ error: err.message });
    res.status(503).json({ error: 'Business insights failed', message: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. CONVERSATION MANAGEMENT
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/conversations', auth, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '20', 10), 50);
  const offset = parseInt(req.query.offset || '0', 10);

  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.client_id, c.pinned,
            c.created_at, c.updated_at,
            (SELECT content FROM ai_messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT COUNT(*) FROM ai_messages WHERE conversation_id=c.id) AS message_count
     FROM ai_conversations c
     WHERE c.user_id=$1
     ORDER BY c.pinned DESC, c.updated_at DESC
     LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]
  );
  res.json({ data: rows });
});

/**
 * PATCH /api/ai/conversations/:id — rename and/or pin.
 * Both fields are optional; sending neither is a 400 rather than a silent
 * no-op that would look like a failed save to the caller.
 */
router.patch('/conversations/:id', auth, async (req, res) => {
  const { title, pinned } = req.body || {};

  const sets = [];
  const params = [req.params.id, req.user.id];

  if (title !== undefined) {
    const clean = String(title).trim().slice(0, 200);
    if (!clean) return res.status(400).json({ error: 'title cannot be empty' });
    params.push(clean);
    sets.push(`title = $${params.length}`);
  }
  if (pinned !== undefined) {
    params.push(Boolean(pinned));
    sets.push(`pinned = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update — send title and/or pinned' });

  // Deliberately does NOT touch updated_at: renaming or pinning a
  // conversation is not activity in it, and bumping the timestamp would
  // reshuffle the "most recent" ordering of the history list under the user.
  const { rows } = await pool.query(
    `UPDATE ai_conversations SET ${sets.join(', ')}
     WHERE id = $1 AND user_id = $2
     RETURNING id, title, pinned, client_id, created_at, updated_at`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ data: rows[0] });
});

router.get('/conversations/:id', auth, async (req, res) => {
  const { rows: [conv] } = await pool.query(
    'SELECT * FROM ai_conversations WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const { rows: messages } = await pool.query(
    'SELECT id, role, content, provider, created_at FROM ai_messages WHERE conversation_id=$1 ORDER BY created_at ASC',
    [req.params.id]
  );

  res.json({ data: { ...conv, messages } });
});

router.delete('/conversations/:id', auth, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM ai_conversations WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ message: 'Conversation deleted' });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. USAGE STATS
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/usage', auth, async (req, res) => {
  const stats = await getUserUsage(req.user.id);
  res.json({ data: stats });
});

router.get('/model-stats', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const stats = await getModelStats();
  res.json({ data: stats });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. MODEL HEALTH CHECK  (admin)
   GET /api/ai/health
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/health', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!process.env.OPENROUTER_API_KEY) {
    return res.json({
      configured: false,
      models: { primary: models.primary, secondary: models.secondary, fallback: models.fallback },
    });
  }

  const [primary, secondary, fallback] = await Promise.all([
    pingModel(models.primary),
    pingModel(models.secondary),
    pingModel(models.fallback),
  ]);

  res.json({
    configured: true,
    models: { primary, secondary, fallback },
    overall: [primary, secondary, fallback].some(m => m.status === 'ok') ? 'ok' : 'degraded',
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. TEST  (admin)
   POST /api/ai/test
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/test', auth, requireConfigured, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { intent = 'chat', prompt = 'Say "MY PT STUDIO AI is ready" and nothing else.' } = req.body || {};
  try {
    const result = await routedChat({
      intent,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 50,
      temperature: 0,
    });
    res.json({
      success:      true,
      message:      result.content,
      model:        result.model,
      tier:         result.tier,
      latency_ms:   result.latency_ms,
      used_fallback:result.used_fallback,
    });
  } catch (err) {
    res.status(503).json({ success: false, message: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. PROVIDER SETTINGS  (admin — for integrations page)
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/provider-settings', auth, adminOnly, async (req, res) => {
  res.json({
    data: {
      provider:   'openrouter',
      configured: !!process.env.OPENROUTER_API_KEY,
      models: {
        primary:   models.primary,
        secondary: models.secondary,
        fallback:  models.fallback,
      },
      base_url: 'https://openrouter.ai/api/v1',
    },
  });
});

module.exports = router;
