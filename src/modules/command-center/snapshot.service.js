// src/modules/command-center/snapshot.service.js
//
// Collects every registered card in parallel and caches per-collector.
//
// Two properties the rest of the Command Center depends on:
//
//   1. One snapshot call never takes longer than the slowest collector's own
//      timeout. Collectors run concurrently and each carries its own deadline,
//      so a wedged Docker socket costs 3 seconds once, not 3 seconds per card
//      and not the whole request.
//
//   2. It cannot throw. The WebSocket tick and the HTTP endpoint both call
//      this on a timer; a rejection there would kill the stream for every
//      connected operator, at exactly the moment the console matters.
'use strict';

const registry = require('./registry');

/** name -> { at: epochMs, value: result } */
const cache = new Map();

function cached(name, ttlMs) {
  if (!ttlMs) return null;
  const hit = cache.get(name);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) return null;
  // Marked so the client can tell a fresh probe from a served-from-cache one —
  // an operator watching a latency number needs to know it is 4 seconds old.
  return { ...hit.value, cached: true };
}

/**
 * Collect the named cards (default: all registered).
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.only]   subset of card names
 * @param {boolean}  [opts.fresh]  bypass the TTL cache (the manual Refresh button)
 */
async function collect(opts = {}) {
  const wanted = opts.only?.length ? opts.only : registry.names();
  const started = Date.now();

  const cards = await Promise.all(wanted.map(async (name) => {
    const entry = registry.get(name);
    // Asking for a card that does not exist is a client bug, not a server
    // error: report it as one unavailable card rather than failing the batch.
    if (!entry) return registry.unavailable(name, 'No such collector');

    if (!opts.fresh) {
      const hit = cached(name, entry.ttlMs);
      if (hit) return hit;
    }

    const value = await registry.runCollector(entry);
    if (entry.ttlMs) cache.set(name, { at: Date.now(), value });
    return value;
  }));

  const byName = {};
  for (const c of cards) byName[c.name] = c;

  return {
    status: registry.rollup(cards.map((c) => c.status)),
    collected_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    cards: byName,
  };
}

/** Drop cached values so the next collect re-probes. */
function invalidate(name) {
  if (name) cache.delete(name); else cache.clear();
}

module.exports = { collect, invalidate };
