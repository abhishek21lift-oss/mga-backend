'use strict';
// AI model registry. No hardcoded model names anywhere in the application.
//
// Each tier resolves in one order, most specific first:
//   1. an operator override set in the Control Centre (lib/ai/settings.js)
//   2. the environment variable
//   3. the built-in default
//
// Step 1 is new and is additive: the override cache starts empty and stays
// empty if the database is unreachable, so with no override set — which is
// every deploy's starting state — this resolves exactly as it always did.
// Nothing about steps 2 and 3 changed.

const settings = require('./settings');

const DEFAULTS = {
  primary:   'openai/gpt-oss-120b:free',
  secondary: 'poolside/laguna-m.1:free',
  fallback:  'nvidia/nemotron-3-ultra-550b-a55b:free',
};

const models = {
  get primary()   { return settings.override('primary')   || process.env.AI_PRIMARY_MODEL   || DEFAULTS.primary; },
  get secondary() { return settings.override('secondary') || process.env.AI_SECONDARY_MODEL || DEFAULTS.secondary; },
  get fallback()  { return settings.override('fallback')  || process.env.AI_FALLBACK_MODEL  || DEFAULTS.fallback; },
};

// Intent → tier routing table
const INTENT_ROUTES = {
  // Fitness — primary model (gpt-oss-120b)
  chat:         'primary',
  workout:      'primary',
  diet:         'primary',
  nutrition:    'primary',
  fitness:      'primary',
  assessment:   'primary',
  progress:     'primary',
  coaching:     'primary',
  exercise:     'primary',
  meal:         'primary',
  goal:         'primary',
  recovery:     'primary',

  // Development — secondary model (poolside/laguna-m1)
  code:         'secondary',
  debug:        'secondary',
  sql:          'secondary',
  audit:        'secondary',
  technical:    'secondary',
  architecture: 'secondary',
  refactor:     'secondary',
  database:     'secondary',

  // Business reporting — fallback model (nvidia/nemotron-3-ultra)
  business:     'fallback',
  insights:     'fallback',
  report:       'fallback',
  analytics:    'fallback',
  summary:      'fallback',

  // Agent domain intents — mapped to appropriate model tiers
  attendance:   'secondary',
  checkin:      'secondary',
  absent:       'secondary',
  client:       'secondary',
  member:       'secondary',
  trainer:      'secondary',
  session:      'secondary',
  booking:      'secondary',
  pt:           'secondary',
  finance:      'fallback',
  payment:      'fallback',
  invoice:      'fallback',
  dues:         'fallback',
  subscription: 'fallback',
  renew:        'secondary',
  whatsapp:     'secondary',
  notify:       'secondary',
  communication:'secondary',
  coach:        'primary',
  retention:    'fallback',
  revenue:      'fallback',
  trend:        'fallback',
};

function resolveModel(intent) {
  const tier = INTENT_ROUTES[intent] || 'primary';
  return { model: models[tier], tier, intent };
}

function getFallbackModel(currentTier) {
  if (currentTier === 'primary' || currentTier === 'secondary') {
    return { model: models.fallback, tier: 'fallback' };
  }
  return null;
}

module.exports = { models, resolveModel, getFallbackModel, INTENT_ROUTES, DEFAULTS };
