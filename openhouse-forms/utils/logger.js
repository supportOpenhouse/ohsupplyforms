// Activity Logger — non-blocking, fire-and-forget
let _pool = null;
const DASHBOARD = 'Forms';

function init(pool) { _pool = pool; }

// Returns the new activity_logs.id (or null if logging failed / pool not ready),
// so callers that need to reference the row — e.g. wa_interakt_id.log_id — can.
async function log(uid, action, category, actorEmail, actorName, details = {}) {
  if (!_pool) return null;
  try {
    const { rows } = await _pool.query(
      `INSERT INTO activity_logs (uid, action, category, actor_email, actor_name, dashboard, details, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() AT TIME ZONE 'Asia/Kolkata') RETURNING id`,
      [uid || null, action, category, actorEmail || null, actorName || null, DASHBOARD, JSON.stringify(details)]
    );
    return rows.length ? rows[0].id : null;
  } catch (e) { console.error('Logger error:', e.message); return null; }
}

// WhatsApp is logged BEFORE sending (so wa_interakt_id rows can carry log_id).
// Once the batch finishes, fold the per-recipient outcomes back into the same row.
async function updateWhatsAppResults(logId, results) {
  if (!_pool || !logId) return;
  try {
    await _pool.query(
      `UPDATE activity_logs SET details = details || $2::jsonb WHERE id = $1`,
      [logId, JSON.stringify({ recipients: results || [] })]
    );
  } catch (e) { console.error('Logger error (wa results):', e.message); }
}

// Field-level diff of two DB rows (both come from pg, so types already match).
// Ignores bookkeeping columns that change on every write.
function diffRows(oldRow, newRow) {
  const changes = {};
  if (!oldRow || !newRow) return changes;
  const skip = k => k === 'created_at' || k === 'updated_at' || /_submitted_at$/.test(k);
  const norm = v => v == null ? null : (v instanceof Date ? v.toISOString() : (typeof v === 'object' ? JSON.stringify(v) : v));
  for (const k of new Set([...Object.keys(oldRow), ...Object.keys(newRow)])) {
    if (skip(k)) continue;
    const o = oldRow[k], n = newRow[k];
    const no = norm(o), nn = norm(n);
    if (no === nn) continue;
    if (no != null && nn != null && no !== '' && nn !== '' && !isNaN(no) && !isNaN(nn) && Number(no) === Number(nn)) continue; // numeric-equal (REAL vs text)
    changes[k] = { old: o ?? null, new: n ?? null };
  }
  return changes;
}

// ── Form Submissions — action = form name ──
// The 6th arg is either a legacy boolean (isDraft) or an options object:
//   { isDraft, wasSubmitted, oldRow, newRow }
// When wasSubmitted is true, logs "<form>_resubmitted" with a field-level {old,new} diff.
function logFormSubmit(uid, action, formNumber, actorEmail, actorName, opts = false) {
  const o = (opts && typeof opts === 'object') ? opts : { isDraft: !!opts };
  const isDraft = !!o.isDraft;
  if (o.wasSubmitted) {
    const changes = diffRows(o.oldRow, o.newRow);
    const reAction = action.replace(/_submitted$/, '_resubmitted');
    return log(uid, reAction, 'form', actorEmail, actorName,
      { form_number: formNumber, is_draft: isDraft, resubmitted: true, changed_fields: Object.keys(changes), changes });
  }
  return log(uid, action, 'form', actorEmail, actorName, { form_number: formNumber, is_draft: isDraft });
}

// ── Emails — action = email type ──
function logEmailSent(uid, action, sender, toList, ccList, gmailId, subject) {
  const to = Array.isArray(toList) ? toList : (toList || '').split(',').map(e => e.trim()).filter(Boolean);
  const cc = Array.isArray(ccList) ? ccList : (ccList || '').split(',').map(e => e.trim()).filter(Boolean);
  return log(uid, action, 'email', sender, null, { to, cc, gmail_id: gmailId || null, subject: subject || null });
}

// ── Status — action = specific status name ──
function logStatusChange(uid, action, oldVal, newVal, actorEmail, actorName) {
  return log(uid, action, 'status', actorEmail, actorName, { old: oldVal, new: newVal });
}

// ── Assignment — action = specific change name ──
function logAssignment(uid, action, oldVal, newVal, actorEmail, actorName, source) {
  return log(uid, action, 'assignment', actorEmail, actorName, { old: oldVal || null, new: newVal || null, source: source || null });
}

// ── Schedule — action = reschedule/reassign ──
function logScheduleChange(uid, action, details, actorEmail, actorName) {
  return log(uid, action, 'schedule', actorEmail, actorName, details);
}

// ── Admin Edits ──
function logAdminEdit(uid, changes, actorEmail, actorName) {
  return log(uid, 'admin_edit', 'admin', actorEmail, actorName, { changes });
}

// ── WhatsApp Notifications ──
function logWhatsApp(uid, templateName, recipients, actorEmail, actorName) {
  const action = `wa_${templateName}`;
  return log(uid, action, 'whatsapp', actorEmail || null, actorName || null, { template: templateName, recipients: recipients || [] });
}

// ── User Management — action: user_created | user_updated | user_deleted ──
function logUserChange(action, targetUser, changes, actorEmail, actorName) {
  return log(null, action, 'user_mgmt', actorEmail || null, actorName || null, {
    target_email: targetUser?.email || null,
    target_id: targetUser?.id || null,
    changes: changes || null,
  });
}

module.exports = { init, log, logFormSubmit, logEmailSent, logWhatsApp, updateWhatsAppResults, logStatusChange, logAssignment, logScheduleChange, logAdminEdit, logUserChange };