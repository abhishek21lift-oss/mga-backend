// Shared ID generation utilities for clients

/**
 * Generate next sequential client_id (FS#####) inside an open transaction.
 * Caller must hold pg_advisory_xact_lock to serialise concurrent inserts.
 * @param {import('pg').PoolClient} client - transaction-bound pg client
 * @returns {Promise<string>} e.g. "FS00001"
 */
async function generateClientId(client) {
  const { rows: last } = await client.query(
    `SELECT client_id FROM clients
      WHERE client_id ~ '^FS[0-9]+$'
      ORDER BY CAST(SUBSTRING(client_id FROM 3) AS INTEGER) DESC
      LIMIT 1`
  );
  if (!last[0]?.client_id) return 'FS00001';
  const n = parseInt(last[0].client_id.replace('FS', ''), 10) + 1;
  return 'FS' + String(n).padStart(5, '0');
}

/**
 * Generate next sequential member_code (SIX19-#####) inside an open transaction.
 * Caller must hold pg_advisory_xact_lock to serialise concurrent inserts.
 * @param {import('pg').PoolClient} client - transaction-bound pg client
 * @returns {Promise<string>} e.g. "SIX19-00001"
 */
async function generateMemberCode(client) {
  const { rows: lastMc } = await client.query(
    `SELECT member_code FROM clients
      WHERE member_code ~ '^SIX19-[0-9]+$'
      ORDER BY CAST(SUBSTRING(member_code FROM 7) AS INTEGER) DESC
      LIMIT 1`
  );
  if (!lastMc[0]?.member_code) return 'SIX19-00001';
  const n = parseInt(lastMc[0].member_code.replace('SIX19-', ''), 10) + 1;
  return 'SIX19-' + String(n).padStart(5, '0');
}

module.exports = { generateClientId, generateMemberCode };