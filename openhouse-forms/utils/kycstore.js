// Private storage for KYC papers — owner (Form 3), co-owner (Form 6) and CP (CP Bill)
// Aadhaar / PAN / cheque / COI / GST invoice. Same Google Cloud Storage bucket and the
// same rules as the CRM (Transaction-Management-Dashboard backend/app/kycstore.py):
//
//   - an uploaded file is stored as the reference "gs://<bucket>/<object>" in the SAME
//     *_url column a Cloudinary link uses, so old rows keep their Cloudinary links;
//   - nothing in the bucket is public: a browser gets a short-lived V4 signed URL
//     (resolve), and the server reads files directly with the service account (read).
//
// Talks to the GCS JSON API with googleapis' JWT client (already a dependency) and
// signs URLs with Node's crypto, so nothing new is installed.
//
// Env: OPENHOUSE_TMD_SELLER_KYC_JSON (service account key JSON), SELLER_KYC_BUCKET,
// SELLER_KYC_URL_MINUTES. Unset → configured() is false: uploads answer 503, and
// reads pass values through (a reference then resolves to null).
const crypto = require('crypto');

const HOST = 'storage.googleapis.com';
const BUCKET = (process.env.SELLER_KYC_BUCKET || 'openhouse-tmd-seller-kyc').trim();
const URL_MINUTES = parseInt(process.env.SELLER_KYC_URL_MINUTES || '15', 10) || 15;
const SCOPES = ['https://www.googleapis.com/auth/devstorage.read_write'];

// The *_url columns whose files live in the bucket when uploaded from now on.
const KYC_COLS = [
  'owner_aadhaar_front_url', 'owner_aadhaar_back_url', 'owner_pan_url', 'owner_property_doc_url', 'cheque_image_url',
  'co_owner_aadhaar_front_url', 'co_owner_aadhaar_back_url', 'co_owner_pan_url', 'co_owner_cheque_url',
  'cp_aadhaar_front_url', 'cp_aadhaar_back_url', 'cp_pan_card_url', 'cp_cancelled_cheque_url', 'cp_coi_url', 'cp_gst_invoice_url',
];
const KYC_COL_SET = new Set(KYC_COLS);

let _key = null, _jwt = null;
function key() {
  if (_key) return _key;
  const raw = (process.env.OPENHOUSE_TMD_SELLER_KYC_JSON || '').trim();
  if (!raw) return null;
  try { _key = JSON.parse(raw); } catch (e) { console.error('kycstore: credentials are not valid JSON'); return null; }
  return _key;
}
function configured() { return !!(BUCKET && key()); }

async function token() {
  if (!configured()) throw Object.assign(new Error('KYC storage is not configured on this server'), { status: 503 });
  if (!_jwt) {
    const { google } = require('googleapis');
    const k = key();
    _jwt = new google.auth.JWT({ email: k.client_email, key: k.private_key, scopes: SCOPES });
  }
  const { token: t } = await _jwt.getAccessToken();
  return t;
}

// Python's urllib.parse.quote: letters, digits and "_.-~" stay, plus `safe`.
function quote(s, safe = '') {
  return Array.from(Buffer.from(String(s), 'utf-8')).map(b => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9_.\-~]/.test(c) || safe.includes(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }).join('');
}

// supply-kyc/<OHID>/<role>/<doc_key>/<uuid><ext> — a fresh name per upload, so a
// replacement never overwrites a file someone may be looking at.
function objectName(uid, role, docKey, filename) {
  let ext = '';
  if (filename && filename.includes('.')) ext = '.' + filename.split('.').pop().toLowerCase().slice(0, 5);
  const safe = v => String(v || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return `supply-kyc/${safe(uid)}/${safe(role)}/${safe(docKey)}/${crypto.randomUUID().replace(/-/g, '')}${ext}`;
}

async function upload(name, buffer, contentType) {
  const url = `https://${HOST}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${quote(name)}`;
  const r = await fetch(url, { method: 'POST', body: buffer,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': contentType } });
  if (r.status !== 200 && r.status !== 201) throw Object.assign(new Error(`KYC storage refused the upload (${r.status})`), { status: 502 });
  return r.json();
}

async function remove(name) {
  try {
    const r = await fetch(`https://${HOST}/storage/v1/b/${BUCKET}/o/${quote(name)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${await token()}` } });
    return [200, 204, 404].includes(r.status);
  } catch (e) { return false; }
}

// (buffer, contentType) of an object — server-side, no signed URL needed.
async function read(name) {
  const r = await fetch(`https://${HOST}/storage/v1/b/${BUCKET}/o/${quote(name)}?alt=media`,
    { headers: { Authorization: `Bearer ${await token()}` } });
  if (r.status !== 200) throw new Error(`KYC storage read failed (${r.status})`);
  return { buffer: Buffer.from(await r.arrayBuffer()),
    contentType: (r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim() };
}

// A V4 signed URL (GOOG4-RSA-SHA256), valid `minutes` (max 7 days). The same
// documented algorithm as the CRM's kycstore.signed_url; the key does the signing.
function signedUrl(name, minutes, method = 'GET') {
  const k = key();
  if (!k) throw new Error('KYC storage is not configured on this server');
  minutes = parseInt(minutes || URL_MINUTES, 10);
  const iso = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');  // YYYYMMDDTHHMMSSZ
  const stamp = iso, day = iso.slice(0, 8);
  const scope = `${day}/auto/storage/goog4_request`;
  const path = `/${BUCKET}/${quote(name, '/~')}`;
  const params = {
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${k.client_email}/${scope}`,
    'X-Goog-Date': stamp,
    'X-Goog-Expires': String(minutes * 60),
    'X-Goog-SignedHeaders': 'host',
  };
  const query = Object.keys(params).sort().map(p => `${quote(p, '~')}=${quote(params[p], '~')}`).join('&');
  const canonical = [method, path, query, `host:${HOST}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', stamp, scope,
    crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const signature = crypto.createSign('RSA-SHA256').update(toSign).sign(k.private_key, 'hex');
  return `https://${HOST}${path}?${query}&X-Goog-Signature=${signature}`;
}

// ---- References ----
function refFor(name) { return `gs://${BUCKET}/${name}`; }

// The object name of a reference to OUR bucket — also accepts a signed URL we minted
// (a form echoing back what it was shown) — else null.
function nameFromRef(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!BUCKET || !v) return null;
  for (const prefix of [`gs://${BUCKET}/`, `https://${HOST}/${BUCKET}/`]) {
    if (v.startsWith(prefix)) {
      try { return decodeURIComponent(v.slice(prefix.length).split('?')[0]) || null; } catch (e) { return null; }
    }
  }
  return null;
}
function isRef(value) { return nameFromRef(value) !== null; }

// Normalise a value about to be stored: a signed URL of ours becomes its reference
// (signed URLs expire); anything else is returned as is.
function toRef(value) { const n = nameFromRef(value); return n ? refFor(n) : value; }

// A URL a browser can open: signed for a reference, the value itself otherwise.
// Never throws — an unsignable reference comes back as null.
function resolve(value, minutes) {
  const n = nameFromRef(value);
  if (!n) return value;
  try { return signedUrl(n, minutes); } catch (e) { return null; }
}

function resolveRow(row, cols = KYC_COLS, minutes) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const c of cols) if (out[c]) out[c] = resolve(out[c], minutes);
  return out;
}

// Deep walk (objects/arrays, a few levels) applying fn to KYC columns only. Used by the
// response/request hooks in server.js so every route is covered without touching each.
function mapKycFields(v, fn, depth = 0) {
  if (depth > 4 || v === null || typeof v !== 'object' || Buffer.isBuffer(v) || v instanceof Date) return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map(x => { const y = mapKycFields(x, fn, depth + 1); if (y !== x) changed = true; return y; });
    return changed ? out : v;
  }
  let out = v;
  for (const k of Object.keys(v)) {
    const cur = v[k];
    const next = KYC_COL_SET.has(k) && typeof cur === 'string' ? fn(cur) : mapKycFields(cur, fn, depth + 1);
    if (next !== cur) { if (out === v) out = { ...v }; out[k] = next; }
  }
  return out;
}

module.exports = { KYC_COLS, configured, objectName, upload, remove, read, signedUrl,
  refFor, nameFromRef, isRef, toRef, resolve, resolveRow, mapKycFields };
