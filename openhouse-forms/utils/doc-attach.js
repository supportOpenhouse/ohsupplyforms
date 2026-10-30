// Documents (KYC, cheques, the signed AMA, CP papers) go into mails as ATTACHMENTS,
// not links: the bucket they live in is going private, and a link a recipient
// can't open is worse than none. The server downloads each file and attaches it.
//
// A file that can't be fetched (or would push the mail past Gmail's size limit)
// falls back to its link, so the mail still goes and nothing silently disappears.
//
// A file in the private KYC bucket (a gs:// reference, see ./kycstore) is read with
// the service account; anything else (old Cloudinary links) is downloaded as before.
const kycstore = require('./kycstore');

const MAX_FILE = 15 * 1024 * 1024;   // one document
const MAX_TOTAL = 20 * 1024 * 1024;  // all attachments together (Gmail caps a mail at 25 MB)

const EXT_BY_TYPE = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif',
};

async function fetchDoc(url) {
  const name = kycstore.nameFromRef(url);
  if (name) {
    const { buffer, contentType } = await kycstore.read(name);
    if (!buffer.length) throw new Error('empty file');
    if (buffer.length > MAX_FILE) throw new Error(`too large (${buffer.length} bytes)`);
    return { buffer, contentType };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buffer = Buffer.from(await r.arrayBuffer());
    if (!buffer.length) throw new Error('empty file');
    if (buffer.length > MAX_FILE) throw new Error(`too large (${buffer.length} bytes)`);
    const contentType = (r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    return { buffer, contentType };
  } finally { clearTimeout(t); }
}

function extFor(url, contentType) {
  const m = String(kycstore.nameFromRef(url) || url).split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return (m && m[1].toLowerCase()) || EXT_BY_TYPE[contentType] || 'bin';
}

// docs: [{ key, label, url }] → { attachments, attached: { key: filename }, missed: [{key,label,url,error}] }
// Filenames read "<uid>_<Label>.<ext>" so the recipient can tell them apart.
async function collectDocs(uid, docs) {
  const attachments = [], attached = {}, missed = [];
  let total = 0;
  const wanted = docs.filter(d => d && d.url);
  const fetched = await Promise.all(wanted.map(d => fetchDoc(d.url).then(f => ({ d, f }), e => ({ d, e }))));
  for (const { d, f, e } of fetched) {
    if (e) { console.error(`Attach ${uid}/${d.key}: ${e.message}`); missed.push({ ...d, error: e.message }); continue; }
    if (total + f.buffer.length > MAX_TOTAL) { missed.push({ ...d, error: 'mail size limit' }); continue; }
    total += f.buffer.length;
    const filename = `${uid || 'doc'}_${d.label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}.${extFor(d.url, f.contentType)}`;
    attachments.push({ filename, contentType: f.contentType, buffer: f.buffer });
    attached[d.key] = filename;
  }
  return { attachments, attached, missed };
}

// The body line for one document: "attached" when it is, its link otherwise. A private
// file's fallback link is signed for 7 days (the V4 maximum).
function docLine(doc, attached, linkText = 'Click here to view') {
  if (!doc || !doc.url) return '';
  if (attached[doc.key]) return `<p><strong>${doc.label}:</strong> Attached (${attached[doc.key]})</p>`;
  const href = kycstore.isRef(doc.url) ? kycstore.resolve(doc.url, 7 * 24 * 60) : doc.url;
  if (!href) return `<p><strong>${doc.label}:</strong> could not be attached</p>`;
  return `<p><strong>${doc.label}:</strong> <a href="${href}" target="_blank" style="color:#1a73e8;text-decoration:underline">${linkText}</a></p>`;
}

module.exports = { collectDocs, docLine, fetchDoc };
