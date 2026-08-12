'use strict';
// Seed two studios with deliberately distinguishable data.
//
// This is the fixture the cross-tenant isolation E2E asserts against. It is
// NOT general-purpose test data: every value here is chosen so that a leak is
// unambiguous in a failure message. Studio A's client is "ALPHA-ONLY-CLIENT"
// and studio B's is "BRAVO-ONLY-CLIENT", so an assertion that A's page never
// contains "BRAVO" cannot pass by accident, and a failure names exactly what
// crossed the boundary.
//
// Run against a THROWAWAY database only. It refuses to touch anything that
// looks like production.


const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const ORG_B = '0b000000-0000-4000-8000-000000000002';

const FIXTURE = {
  a: {
    orgId: ORG_A,
    orgName: 'Alpha Studio',
    email: 'owner-a@e2e.test',
    userId: 'usr-e2e-alpha',
    trainerId: 'trn-e2e-alpha',
    trainerName: 'ALPHA-ONLY-TRAINER',
    clientId: 'ptc-e2e-alpha',
    clientName: 'ALPHA-ONLY-CLIENT',
    clientMobile: '9000000001',
    amount: 11111,
  },
  b: {
    orgId: ORG_B,
    orgName: 'Bravo Studio',
    email: 'owner-b@e2e.test',
    userId: 'usr-e2e-bravo',
    trainerId: 'trn-e2e-bravo',
    trainerName: 'BRAVO-ONLY-TRAINER',
    clientId: 'ptc-e2e-bravo',
    clientName: 'BRAVO-ONLY-CLIENT',
    clientMobile: '9000000002',
    amount: 22222,
  },
};

const PASSWORD = 'E2ePassw0rd!seed';

async function guardNotProduction() {
  const url = process.env.DATABASE_URL || '';
  if (/supabase|pooler|amazonaws|prod/i.test(url)) {
    throw new Error(`Refusing to seed: DATABASE_URL looks like a real environment (${url.replace(/:[^:@]*@/, ':***@')})`);
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM organizations');
  if (rows[0].n > 5) {
    throw new Error(`Refusing to seed: ${rows[0].n} organizations already present — this is not a throwaway database`);
  }
}

async function seedStudio(s, hash) {
  await pool.query(
    `INSERT INTO organizations (id, name, slug, status, created_at)
     VALUES ($1, $2, $3, 'active', NOW())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [s.orgId, s.orgName, s.orgName.toLowerCase().replace(/\s+/g, '-')]
  );

  await pool.query(
    `INSERT INTO trainers (id, name, email, mobile, status, organization_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $5, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [s.trainerId, s.trainerName, `trainer-${s.orgName}@e2e.test`, s.clientMobile, s.orgId]
  );

  await pool.query(
    `INSERT INTO users (id, name, email, password, role, is_active, organization_id,
                        trainer_id, token_version, failed_login_attempts, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'admin', TRUE, $5, $6, 0, 0, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password, organization_id = EXCLUDED.organization_id`,
    [s.userId, `${s.orgName} Owner`, s.email, hash, s.orgId, s.trainerId]
  );

  await pool.query(
    `INSERT INTO pt_clients (id, name, mobile, trainer_id, base_amount, discount, final_amount,
                             paid_amount, balance_amount, monthly_pt_amount, trainer_commission,
                             status, organization_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 0, $5, 0, $5, 0, 0, 'active', $6, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, organization_id = EXCLUDED.organization_id`,
    [s.clientId, s.clientName, s.clientMobile, s.trainerId, s.amount, s.orgId]
  );

  await pool.query(
    `INSERT INTO pt_payments (id, client_id, trainer_id, amount, incentive_amt, payment_method,
                              payment_ref, date, organization_id, created_at)
     VALUES ($1, $2, $3, $4, 0, 'CASH', $5, CURRENT_DATE, $6, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [`pay-e2e-${s.orgName.split(' ')[0].toLowerCase()}`, s.clientId, s.trainerId,
     s.amount, `RCPT-${s.orgName.split(' ')[0].toUpperCase()}`, s.orgId]
  );
}

async function main() {
  await guardNotProduction();
  const hash = await bcrypt.hash(PASSWORD, 10);

  for (const s of [FIXTURE.a, FIXTURE.b]) await seedStudio(s, hash);

  const { rows } = await pool.query(
    `SELECT o.name, count(DISTINCT c.id)::int AS clients, count(DISTINCT p.id)::int AS payments
       FROM organizations o
       LEFT JOIN pt_clients  c ON c.organization_id = o.id
       LEFT JOIN pt_payments p ON p.organization_id = o.id
      WHERE o.id = ANY($1::uuid[])
      GROUP BY o.name ORDER BY o.name`,
    [[ORG_A, ORG_B]]
  );
  console.log(JSON.stringify({ seeded: rows, password: PASSWORD }, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});

module.exports = { FIXTURE, PASSWORD };
