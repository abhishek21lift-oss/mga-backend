// The deploy pipeline is gated on CI, and the gate is wired to a name.
//
// Audit finding H-1. ci.yml and deploy.yml both triggered on `push: main`, so
// they raced: a commit that failed lint, tests or `npm audit` still deployed,
// because nothing connected them. The suite was advisory.
//
// The fix makes deploy.yml trigger on `workflow_run` of the CI workflow and
// require conclusion == 'success'. That works, but it is wired by a STRING —
// the CI workflow's display name, repeated in deploy.yml. Rename ci.yml's
// `name:` and the trigger silently stops matching: no error, no warning, and
// deploys simply never fire again. The failure mode is "nothing happens",
// which is exactly the kind nobody notices until a release is overdue.
//
// So the name match is asserted here, along with the properties that make the
// gate a gate rather than decoration.

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WF = path.join(__dirname, '..', '..', '.github', 'workflows');

const load = (f) => yaml.load(fs.readFileSync(path.join(WF, f), 'utf8'));

// `on` is the YAML 1.1 boolean true, so js-yaml parses the key as `true`
// unless quoted. Read both spellings rather than depending on which it is.
const triggers = (doc) => doc[true] || doc.on;

describe('deploy is gated on CI', () => {
  const ci = load('ci.yml');
  const deploy = load('deploy.yml');

  it('deploy no longer triggers directly on a push to main', () => {
    // This is the whole finding. If `push` comes back, the gate is bypassed
    // for every ordinary commit and the rest of this file is cosmetic.
    expect(triggers(deploy).push).toBeUndefined();
  });

  it('deploy triggers on the CI workflow completing', () => {
    const wr = triggers(deploy).workflow_run;
    expect(wr).toBeDefined();
    expect(wr.types).toContain('completed');
    expect(wr.branches).toContain('main');
  });

  it('the workflow name deploy waits on is exactly the name CI declares', () => {
    // The silent-breakage guard. A rename on either side fails here instead of
    // quietly disabling every deploy.
    expect(triggers(deploy).workflow_run.workflows).toContain(ci.name);
  });

  it('the deploy job requires a SUCCESSFUL CI conclusion', () => {
    // workflow_run fires on completion regardless of outcome — failure and
    // cancellation included. Without this condition the new trigger would ship
    // red builds just as reliably as the old one did.
    const cond = String(deploy.jobs.deploy.if);
    expect(cond).toMatch(/workflow_run\.conclusion\s*==\s*'success'/);
  });

  it('keeps a manual dispatch escape hatch', () => {
    expect(triggers(deploy).workflow_dispatch !== undefined).toBe(true);
    expect(String(deploy.jobs.deploy.if)).toMatch(/workflow_dispatch/);
  });

  it('CI still runs on pushes and pull requests, so the gate has something to gate', () => {
    expect(triggers(ci).push.branches).toContain('main');
    expect(triggers(ci).pull_request).toBeDefined();
  });
});

describe('the deploy script', () => {
  const deploy = load('deploy.yml');
  const script = String(deploy.env.DEPLOY_SCRIPT);

  it('applies migrations before starting the new container', () => {
    // Audit finding H-2: there was no migration step at all. `npm run migrate`
    // was manual and out-of-band, which is how the live schema drifted from
    // the tracked migrations in 16+ documented places.
    expect(script).toMatch(/npm run migrate/);
    expect(script.indexOf('npm run migrate')).toBeLessThan(script.indexOf('compose up -d'));
  });

  it('runs migrations in a throwaway container, not the serving one', () => {
    expect(script).toMatch(/compose run --rm --no-deps backend npm run migrate/);
  });

  it('aborts the deploy if anything in the script fails', () => {
    // Without set -e a failed migration would be followed by `up -d` anyway,
    // starting new code against an unmigrated database.
    expect(script).toMatch(/^\s*set -e/m);
  });

  it('recovers a detached HEAD left behind by a rollback', () => {
    // rollback.yml checks out a SHA detached. A bare `git pull origin main`
    // does not move a detached HEAD, so the next deploy would report success
    // and ship nothing.
    expect(script).toMatch(/git checkout main/);
    expect(script).not.toMatch(/^\s*git pull origin main\s*$/m);
  });

  it('records the deployed commit for rollback to target', () => {
    expect(script).toMatch(/\.backend-deployed-sha/);
  });
});

describe('rollback', () => {
  const rb = load('rollback.yml');

  it('is manual only — never automatic', () => {
    const t = triggers(rb);
    expect(Object.keys(t)).toEqual(['workflow_dispatch']);
  });

  it('takes a SHA and requires explicit confirmation', () => {
    const inputs = triggers(rb).workflow_dispatch.inputs;
    expect(inputs.sha.required).toBe(true);
    expect(inputs.confirm.required).toBe(true);
  });

  it('refuses to proceed without the confirmation string', () => {
    const guard = rb.jobs.rollback.steps[0];
    expect(String(guard.if)).toMatch(/confirm != 'ROLLBACK'/);
    expect(String(guard.run)).toMatch(/exit 1/);
  });

  it('verifies the commit exists before checking it out', () => {
    // A typo would otherwise detach the box at an arbitrary or invalid ref
    // mid-incident.
    const step = rb.jobs.rollback.steps.find((s) => /Roll the box back/.test(s.name || ''));
    expect(String(step.with.script)).toMatch(/git cat-file -e/);
  });
});
