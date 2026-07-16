// Alerts top managers whenever any brokerage value changes on a property.
// Callers pass the DB row from BEFORE and AFTER the write, so this catches a change
// from any source (token form re-submit, CP bill, admin edit) without each route
// needing to know which fields moved.
const nodemailer = require('nodemailer');

// Watched fields → label shown in the alert email.
const BROKERAGE_FIELDS = {
  agreed_brokerage: 'Agreed Brokerage (%)',
  total_brokerage_amount: 'Agreed Brokerage (₹)',
  brokerage_ama_signed: 'Brokerage - AMA signed (%)',
  brokerage_ama_signed_amount: 'Brokerage - AMA signed (₹)',
  brokerage_registry: 'Brokerage - Registry (%)',
  brokerage_registry_amount: 'Brokerage - Registry (₹)',
  additional_brokerage: 'Additional Brokerage (₹)',
};

// Columns are TEXT; null/''/undefined all mean "not set". Compare as trimmed strings
// so 2 (number) and '2' (text) don't look like a change.
const norm = v => (v === null || v === undefined) ? '' : String(v).trim();

function diffBrokerage(oldRow, newRow) {
  const out = [];
  for (const [field, label] of Object.entries(BROKERAGE_FIELDS)) {
    const o = norm(oldRow && oldRow[field]);
    const n = norm(newRow && newRow[field]);
    if (o !== n) out.push({ field, label, old: o || '—', new: n || '—' });
  }
  return out;
}

let transporter = null;
function getTransport() {
  if (transporter) return transporter;
  const user = process.env.SUPPORT_SMTP_USER;
  const pass = process.env.SUPPORT_SMTP_PASS;
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  return transporter;
}

const esc = s => String(s == null ? '' : s).replace(/</g, '&lt;');

// Fire-and-forget. Never throws into the request path — callers .catch() anyway.
async function notifyBrokerageChange(pool, oldRow, newRow, actor) {
  const changes = diffBrokerage(oldRow, newRow);
  if (!changes.length) return;

  const t = getTransport();
  if (!t) { console.warn('Brokerage alert skipped: SUPPORT_SMTP_USER/SUPPORT_SMTP_PASS not set'); return; }

  const { rows } = await pool.query(
    `SELECT email FROM users WHERE is_top_manager=TRUE AND is_active=TRUE AND email IS NOT NULL`
  );
  const to = rows.map(r => r.email).filter(Boolean);
  if (!to.length) { console.warn('Brokerage alert skipped: no active top managers'); return; }

  const p = newRow || {};
  const propRef = [p.tower_no, p.unit_no].filter(Boolean).join('-');
  const subject = `${p.uid} - Brokerage Changed | ${propRef} ${p.society_name || ''}`.replace(/\s+/g, ' ').trim();
  const who = esc(actor && (actor.name || actor.email) || 'Unknown');
  const via = actor && actor.source ? ` (${esc(actor.source)})` : '';

  const rowsHtml = changes.map(c => `<tr>
<td style="padding:3px 14px 3px 0">${esc(c.label)}</td>
<td style="padding:3px 14px 3px 0;color:#b33a2e;text-decoration:line-through">${esc(c.old)}</td>
<td style="padding:3px 0;color:#1a7f37;font-weight:bold">${esc(c.new)}</td>
</tr>`).join('\n');

  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">
<p>Brokerage was changed for <strong>${esc(p.uid)}</strong> — ${esc(propRef)} ${esc(p.society_name || '')}.</p>
<p><strong>Changed by:</strong> ${who}${via}</p>
<table style="border-collapse:collapse;font-size:13px;margin-top:6px">
<tr><th align="left" style="padding:3px 14px 3px 0">Field</th><th align="left" style="padding:3px 14px 3px 0">Old</th><th align="left">New</th></tr>
${rowsHtml}
</table>
<p style="margin-top:14px;font-size:12px;color:#777">Source: ${esc(p.source || '—')} &middot; Owner: ${esc(p.owner_broker_name || '—')}</p>
</div>`;

  await t.sendMail({
    from: `Openhouse Support <${process.env.SUPPORT_SMTP_USER}>`,
    to: to.join(', '),
    subject,
    html,
  });
  console.log(`Brokerage alert sent for ${p.uid} to ${to.join(', ')}`);
}

module.exports = { notifyBrokerageChange, diffBrokerage, BROKERAGE_FIELDS };
