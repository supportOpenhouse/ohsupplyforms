// The CP DIRECTORY (`channel_partners`) lives in a DIFFERENT Neon database from
// `properties`, so it needs its own pool. Supply used to keep a private
// `cp_master` table instead; its codes (CP0001…) are a separate numbering scheme
// from the directory's (CP03946…) and resolve to nothing there, so a CP chosen on
// a form could not be mapped to the real partner. This pool is what lets the
// pickers read the directory directly.
//
// Optional by design: if CP_INVENTORY_DB_URL is unset the export is null and the
// callers fall back, so a missing env var degrades the CP search rather than
// taking the whole forms app down.
const { Pool } = require('pg');

const url = process.env.CP_INVENTORY_DB_URL;

const cpPool = url
  ? new Pool({
      connectionString: url,
      ssl: url.includes('neon.tech') ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
    })
  : null;

if (cpPool) {
  cpPool.on('error', (err) => console.error('CP directory pool error:', err.message));
  console.log('CP directory pool ready');
} else {
  console.warn('CP_INVENTORY_DB_URL not set — CP directory search disabled');
}

module.exports = cpPool;
