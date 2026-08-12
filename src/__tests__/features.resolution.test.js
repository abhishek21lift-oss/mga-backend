// Feature resolution precedence.
//
// Pure tests of `decide` — the precedence rules, isolated from the SQL that
// feeds them. These are the rules that will be argued about, and every one of
// them fails silently in production: a studio just quietly loses a feature, or
// quietly keeps one it should not have.
'use strict';

const { decide, SOURCE } = require('../lib/features');

/** A resolved row as the join produces it, with everything permissive. */
function row(over = {}) {
  return {
    key: 'ai_suite', is_core: false, global_enabled: true, default_enabled: true,
    is_plan_gated: false, override_active: false, override_enabled: null,
    plan_enabled: null, ...over,
  };
}

describe('precedence', () => {
  it('core beats everything, including the global kill switch', () => {
    // The schema forbids this combination, but the resolver must not depend on
    // the schema to stay correct — a core feature is never off.
    const r = decide(row({ is_core: true, global_enabled: false, override_active: true, override_enabled: false }));
    expect(r).toEqual({ enabled: true, source: SOURCE.CORE });
  });

  it('the global kill switch beats a per-studio override', () => {
    // The whole point of the incident lever: one flip, no exceptions, no
    // hunting down the studios that were individually granted the feature.
    const r = decide(row({ global_enabled: false, override_active: true, override_enabled: true }));
    expect(r).toEqual({ enabled: false, source: SOURCE.GLOBAL_OFF });
  });

  it('an active override beats the plan', () => {
    const r = decide(row({ is_plan_gated: true, plan_enabled: false, override_active: true, override_enabled: true }));
    expect(r).toEqual({ enabled: true, source: SOURCE.OVERRIDE });
  });

  it('an override can also take a feature away that the plan grants', () => {
    const r = decide(row({ is_plan_gated: true, plan_enabled: true, override_active: true, override_enabled: false }));
    expect(r.enabled).toBe(false);
    expect(r.source).toBe(SOURCE.OVERRIDE);
  });

  it('an expired override is ignored and the plan applies again', () => {
    // The "let them try it for 30 days" path. If an expired grant kept
    // resolving, every trial would be permanent.
    const r = decide(row({ is_plan_gated: true, plan_enabled: false, override_active: false, override_enabled: true }));
    expect(r).toEqual({ enabled: false, source: SOURCE.PLAN });
  });

  it('the plan is consulted only when the feature is plan-gated', () => {
    const r = decide(row({ is_plan_gated: false, plan_enabled: false }));
    expect(r).toEqual({ enabled: true, source: SOURCE.DEFAULT });
  });

  it('falls back to the default when a plan-gated feature has no plan row', () => {
    // A trialling studio has no plan_code. It should see the product, not a
    // wall of locked panels.
    const r = decide(row({ is_plan_gated: true, plan_enabled: null }));
    expect(r).toEqual({ enabled: true, source: SOURCE.DEFAULT });
  });

  it('honours a default of false', () => {
    const r = decide(row({ default_enabled: false }));
    expect(r).toEqual({ enabled: false, source: SOURCE.DEFAULT });
  });
});

describe('the seeded state', () => {
  it('resolves every feature to enabled', () => {
    // Migration 123 seeds exactly this. If it ever stops resolving to true,
    // deploying the migration would silently switch features off for every
    // live studio — the one outcome this whole module must never produce.
    const seeded = row({ global_enabled: true, default_enabled: true, is_plan_gated: false, override_active: false });
    expect(decide(seeded).enabled).toBe(true);
    expect(decide({ ...seeded, is_core: true }).enabled).toBe(true);
  });
});
