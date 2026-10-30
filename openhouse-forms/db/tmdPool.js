// The Transaction Management Dashboard's OWN database (its `deals`,
// `cancel_requests`, `activity_log`), a different Neon database from `properties`.
// Used only by the admin panel's "Cancelled Pre Token" box, which writes the CRM
// deal's cancellation directly.
//
// Optional by design: if TMD_DATABASE_URL is unset the export is null and the box
// shows "not configured" instead of taking the forms app down.
const { Pool } = require('pg');

const url = process.env.TMD_DATABASE_URL;

const tmdPool = url
  ? new Pool({
      connectionString: url,
      ssl: url.includes('neon.tech') ? { rejectUnauthorized: false } : false,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
    })
  : null;

if (tmdPool) {
  tmdPool.on('error', (err) => console.error('TMD pool error:', err.message));
  console.log('TMD pool ready');
} else {
  console.warn('TMD_DATABASE_URL not set — Cancelled Pre Token (CRM) disabled');
}

module.exports = tmdPool;
