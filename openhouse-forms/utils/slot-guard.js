// One rule for every route that puts a visit on an RM's (field_exec's) calendar:
// a visit holds [start, start + 30 min), and no two LIVE visits of the same RM may overlap.
// Used by Form 1 submit, external schedule/reschedule, visit reassign/reschedule/update,
// and the admin edit modal — there is no path that writes a slot without passing here.
//
// Check-then-write is a race (two saves in the same second both pass the check), so the
// check and the write run in one transaction holding an advisory lock on (RM, date):
// every writer targeting that RM + date queues behind the one holding it.
const { dateStr } = require('./visit-history');

const SLOT_MIN = 30;
const DAY_START = 8 * 60, DAY_END = 20 * 60; // suggested slots stay within 8 AM – 8 PM
const LIVE = 'is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE AND replicated IS NOT TRUE';

// 'HH:MM' or 'HH:MM:SS' → minutes since midnight; anything else → NaN.
function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(t ?? '').trim());
  if (!m) return NaN;
  const h = +m[1], mm = +m[2];
  return h < 24 && mm < 60 ? h * 60 + mm : NaN;
}

function fmt12(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${h > 12 ? h - 12 : h === 0 ? 12 : h}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// null if the slot is free, else the clash (with up to 3 free slots on each side).
async function findClash(q, { fieldExec, date, time, excludeUid }) {
  const sel = toMin(time);
  const { rows } = await q.query(
    `SELECT uid, schedule_time, society_name, tower_no, unit_no FROM properties
      WHERE LOWER(TRIM(field_exec)) = LOWER(TRIM($1)) AND schedule_date = $2
        AND uid IS DISTINCT FROM $3 AND ${LIVE}`,
    [fieldExec, date, excludeUid || null]);
  const busy = rows.map(r => ({ ...r, start: toMin(r.schedule_time) })).filter(r => !isNaN(r.start));
  const overlaps = t => busy.some(b => t < b.start + SLOT_MIN && t + SLOT_MIN > b.start);
  const hit = busy.find(b => sel < b.start + SLOT_MIN && sel + SLOT_MIN > b.start);
  if (!hit) return null;

  const free = t => t >= DAY_START && t <= DAY_END && !overlaps(t);
  const before = [], after = [];
  for (let t = sel - 30; t >= DAY_START && before.length < 3; t -= 30) if (free(t)) before.push(t);
  for (let t = sel + 30; t <= DAY_END && after.length < 3; t += 30) if (free(t)) after.push(t);
  const suggested_times = [...before.reverse(), ...after].map(fmt12);

  const flat = [hit.tower_no, hit.unit_no].filter(Boolean).join('-');
  const where = [hit.society_name, flat].filter(Boolean).join(' ');
  const message = `${fieldExec} already has a visit at ${fmt12(hit.start)} on ${date}`
    + ` (${where || 'another property'}, UID ${hit.uid}). `
    + (suggested_times.length ? `Free slots: ${suggested_times.join(', ')}` : 'No free slots left that day');
  return {
    message,
    conflict: { uid: hit.uid, time: hit.schedule_time, society: hit.society_name, tower: hit.tower_no,
                unit: hit.unit_no, field_exec: fieldExec, schedule_date: date },
    suggested_times,
  };
}

// Runs write(q) only if the target slot is free. write gets the transaction client and
// must do its INSERT/UPDATE through it. Returns { result } on success, or
// { error: { status, message, conflict?, suggested_times? } } with nothing written.
// slot = { fieldExec, date, time, excludeUid } — the visit's position AFTER the write;
// excludeUid is the visit being moved, so it doesn't clash with itself.
async function withSlot(pool, slot, write) {
  const fieldExec = String(slot.fieldExec ?? '').trim();
  const date = dateStr(slot.date);
  const time = String(slot.time ?? '').trim();
  // An unassigned or untimed visit occupies no slot on anyone's calendar.
  if (!fieldExec || !date || !time) return { result: await write(pool) };
  if (isNaN(toMin(time))) return { error: { status: 400, message: 'Schedule time must be HH:MM (24-hour), e.g. 14:30' } };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`slot:${fieldExec.toLowerCase()}:${date}`]);
    const clash = await findClash(client, { fieldExec, date, time, excludeUid: slot.excludeUid });
    if (clash) { await client.query('ROLLBACK'); return { error: { status: 409, ...clash } }; }
    const result = await write(client);
    await client.query('COMMIT');
    return { result };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); // don't let a failed rollback hide the real error
    throw e;
  } finally {
    client.release();
  }
}

// Response body for the in-app routes (the external API keeps its own documented shape).
const slotErrorBody = e => ({ error: e.message, conflict: e.conflict, suggested_times: e.suggested_times });

module.exports = { withSlot, findClash, slotErrorBody, toMin, SLOT_MIN };
