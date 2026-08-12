// src/db/seed.js
// One-time admin bootstrap for a fresh database. Run after setup:
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=strong-secret node src/db/seed.js
//
// No demo/sample identities: this creates only the single admin account you
// pass via environment variables. Everyone else (trainers, clients, staff) is
// created through the app UI.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool   = require('./pool');

async function seed() {
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name     = process.env.ADMIN_NAME || 'Admin';

  if (!email || !password) {
    console.error('ADMIN_EMAIL and ADMIN_PASSWORD env vars are required to seed the admin account.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);

  await pool.query(
    `INSERT INTO users (id, name, email, password, role)
     VALUES (gen_random_uuid()::TEXT, $1, $2, $3, 'admin')
     ON CONFLICT (email) DO UPDATE SET password = $3, name = $1, updated_at = NOW()`,
    [name, email, hash]
  );

  console.log(`Admin account ready: ${email}`);
  await pool.end();
}

if (require.main === module) {
  seed().catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  });
}

module.exports = { seed };
