'use strict';
/**
 * PostgreSQL SCRAM-SHA-256 password verifiers, computed locally.
 *
 * ALTER ROLE ... PASSWORD is a utility statement and cannot take a bound
 * parameter, so the value has to be part of the SQL text. Sent as plaintext it
 * would then appear in pg_stat_activity and in the server log, where it
 * outlives the process that set it. Hashing here means the plaintext never
 * leaves the machine — which is exactly what psql's own \password does.
 *
 * Shared by the role-provisioning scripts so there is one implementation to
 * get right rather than one per role. A subtly wrong verifier does not fail
 * loudly; it produces a password that simply never authenticates, so each
 * caller must verify a real login afterwards.
 */

const crypto = require('crypto');

/** PostgreSQL's own default iteration count. */
const DEFAULT_ITERATIONS = 4096;

/**
 * Build the verifier string PostgreSQL would have stored had it hashed the
 * password itself. Format, from src/backend/libpq/crypt.c:
 *
 *   SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>   (base64)
 *
 * `plaintext` must be printable ASCII: anything else needs SASLprep
 * normalisation, which is a dependency and a portability problem, and callers
 * reject non-ASCII before reaching here.
 */
function scramVerifier(plaintext, iterations = DEFAULT_ITERATIONS) {
  const salt = crypto.randomBytes(16);
  const saltedPassword = crypto.pbkdf2Sync(plaintext, salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', saltedPassword).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$`
       + `${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

module.exports = { scramVerifier, DEFAULT_ITERATIONS };
