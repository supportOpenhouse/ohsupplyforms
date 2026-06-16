// Google Calendar sync for scheduled visits.
// Approach: the scheduler's Google account creates ONE event and adds assigned_by +
// assigned_to as attendees (sendUpdates=all), so it lands on their calendars. The
// creator's user id is stored on the property so later edits/deletes use the same token.
const { google } = require('googleapis');

const TZ = 'Asia/Kolkata';

function oauthClient(accessToken, refreshToken) {
  const c = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  c.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  return c;
}

function calClient(accessToken, refreshToken) {
  return google.calendar({ version: 'v3', auth: oauthClient(accessToken, refreshToken) });
}

// Build the human-friendly event summary + location + HTML description (with the
// Directions and Start-Visit-Form links).
function buildEvent(p) {
  const unit = [p.tower_no, p.unit_no].filter(Boolean).join('-');
  const summary = `🏠 Visit Scheduled — ${[p.society_name, unit].filter(Boolean).join(' ')}${p.owner_broker_name ? ' · ' + p.owner_broker_name : ''} (${p.uid})`;
  const location = [p.tower_no, p.unit_no, p.society_name, p.locality, p.city].filter(Boolean).join(', ');
  const mapsQuery = encodeURIComponent([p.society_name, p.locality, p.city].filter(Boolean).join(', '));
  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${mapsQuery}`;
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  const visitUrl = `${base}/visit?uid=${encodeURIComponent(p.uid)}`;
  const description = [
    '<b>Openhouse — Property Visit</b>',
    '',
    `<b>UID:</b> ${p.uid}`,
    `<b>Property:</b> ${location || '—'}`,
    `<b>Owner:</b> ${p.owner_broker_name || '—'}${p.contact_no ? ' (' + p.contact_no + ')' : ''}`,
    `<b>Configuration:</b> ${p.configuration || '—'}`,
    `<b>Assigned By:</b> ${p.assigned_by || '—'}`,
    `<b>Assigned To:</b> ${p.field_exec || '—'}`,
    '',
    `📍 <a href="${directionsUrl}">Directions to the society</a>`,
    `▶️ <a href="${visitUrl}">Start Visit Form for ${p.uid}</a>`,
  ].join('<br>');
  return { summary, location, description };
}

// Normalize schedule_date to 'YYYY-MM-DD'. pg returns a DATE column as a JS Date object,
// so prefer the to_char string (sched_date_str) and fall back to safe formatting.
function scheduleDateStr(p) {
  if (p.sched_date_str) return p.sched_date_str;
  const v = p.schedule_date;
  if (!v) return '';
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).split('T')[0];
}

// Returns Calendar start/end blocks from schedule_date (+ optional schedule_time, 60-min slot).
function eventTimes(p) {
  const date = scheduleDateStr(p);
  if (!date) return null;
  if (p.schedule_time) {
    const t = p.schedule_time.length === 5 ? p.schedule_time : p.schedule_time.slice(0, 5);
    const [h, m] = t.split(':').map(Number);
    const endMin = Math.min(h * 60 + m + 60, 23 * 60 + 59);
    const eh = String(Math.floor(endMin / 60)).padStart(2, '0');
    const em = String(endMin % 60).padStart(2, '0');
    return {
      start: { dateTime: `${date}T${t}:00`, timeZone: TZ },
      end: { dateTime: `${date}T${eh}:${em}:00`, timeZone: TZ },
    };
  }
  // All-day event when no time was set
  const next = new Date(date + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  return { start: { date }, end: { date: next.toISOString().split('T')[0] } };
}

function attendeeList(assignedByEmail, assignedToEmail) {
  const set = [...new Set([assignedByEmail, assignedToEmail].filter(Boolean).map(e => e.toLowerCase()))];
  return set.map(email => ({ email }));
}

async function createVisitEvent({ accessToken, refreshToken, property, assignedByEmail, assignedToEmail }) {
  const times = eventTimes(property);
  if (!times) return null;
  const { summary, location, description } = buildEvent(property);
  const cal = calClient(accessToken, refreshToken);
  const res = await cal.events.insert({
    calendarId: 'primary',
    sendUpdates: 'all',
    requestBody: {
      summary, location, description,
      ...times,
      attendees: attendeeList(assignedByEmail, assignedToEmail),
      reminders: { useDefault: true },
    },
  });
  return res.data.id;
}

async function updateVisitEvent({ accessToken, refreshToken, eventId, property, assignedByEmail, assignedToEmail, summaryPrefix }) {
  const times = eventTimes(property);
  const { summary, location, description } = buildEvent(property);
  const cal = calClient(accessToken, refreshToken);
  const body = {
    summary: (summaryPrefix || '') + summary,
    location, description,
    attendees: attendeeList(assignedByEmail, assignedToEmail),
  };
  if (times) { body.start = times.start; body.end = times.end; }
  await cal.events.patch({ calendarId: 'primary', eventId, sendUpdates: 'all', requestBody: body });
}

async function deleteVisitEvent({ accessToken, refreshToken, eventId }) {
  const cal = calClient(accessToken, refreshToken);
  await cal.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' });
}

// Diagnostic: insert + delete a throwaway event so the caller can surface the real
// Google error (scope missing / Calendar API disabled / token expired). Throws on failure.
async function diagnoseCalendar({ accessToken, refreshToken }) {
  const cal = calClient(accessToken, refreshToken);
  const start = new Date(Date.now() + 3600000);
  const end = new Date(Date.now() + 7200000);
  const res = await cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: 'Openhouse calendar test — safe to delete',
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    },
  });
  const id = res.data.id;
  try { await cal.events.delete({ calendarId: 'primary', eventId: id }); } catch (_) { /* leave it; insert worked */ }
  return id;
}

// ── Orchestrator: load the property + emails + the right Google token, then sync. ──
// action: 'create' | 'update' | 'done' | 'delete'. actorUserId is the logged-in user
// (used as the event creator on 'create'; updates/deletes reuse the stored creator).
async function getTokens(pool, userId) {
  if (!userId) return null;
  const { rows } = await pool.query('SELECT id,email,google_access_token,google_refresh_token FROM users WHERE id=$1', [userId]);
  return rows[0] || null;
}
async function emailForName(pool, name) {
  if (!name) return null;
  const { rows } = await pool.query('SELECT email FROM users WHERE LOWER(name)=LOWER($1) AND is_active=TRUE LIMIT 1', [name]);
  return rows[0] ? rows[0].email : null;
}
async function tokensForName(pool, name) {
  if (!name) return null;
  const { rows } = await pool.query('SELECT id,email,google_access_token,google_refresh_token FROM users WHERE LOWER(name)=LOWER($1) AND is_active=TRUE LIMIT 1', [name]);
  return rows[0] || null;
}
function hasToken(u) { return u && (u.google_access_token || u.google_refresh_token); }

async function syncVisitCalendar(pool, { uid, action, actorUserId }) {
  try {
    const { rows } = await pool.query("SELECT *, to_char(schedule_date,'YYYY-MM-DD') AS sched_date_str FROM properties WHERE uid=$1", [uid]);
    if (!rows.length) return;
    const p = rows[0];
    const assignedByEmail = await emailForName(pool, p.assigned_by);
    const assignedToEmail = await emailForName(pool, p.field_exec);

    if (action === 'create') {
      // Pick whose Google account creates the event: the logged-in scheduler when present
      // (in-app forms), otherwise fall back to assigned_by → assigned_to. The external API
      // (CP Listings / Direct Inventory portals) has no session, so it relies on this fallback.
      let creator = actorUserId ? await getTokens(pool, actorUserId) : null;
      if (!hasToken(creator)) creator = await tokensForName(pool, p.assigned_by);
      if (!hasToken(creator)) creator = await tokensForName(pool, p.field_exec);
      if (!hasToken(creator)) {
        console.log(`Cal: SKIP create ${uid} — no Google token for scheduler/assigned_by(${p.assigned_by})/field_exec(${p.field_exec}). They must log in with calendar access.`);
        return;
      }
      const eventId = await createVisitEvent({ accessToken: creator.google_access_token, refreshToken: creator.google_refresh_token, property: p, assignedByEmail, assignedToEmail });
      if (eventId) await pool.query('UPDATE properties SET gcal_event_id=$1,gcal_creator_id=$2 WHERE uid=$3', [eventId, creator.id, uid]);
      return;
    }

    // No event yet (e.g. scheduled before this feature) — on an update, create it now.
    if (!p.gcal_event_id) {
      if (action === 'update') return syncVisitCalendar(pool, { uid, action: 'create', actorUserId });
      return;
    }

    const creator = await getTokens(pool, p.gcal_creator_id);
    if (!hasToken(creator)) return;
    const creds = { accessToken: creator.google_access_token, refreshToken: creator.google_refresh_token };

    if (action === 'delete') {
      await deleteVisitEvent({ ...creds, eventId: p.gcal_event_id });
      await pool.query('UPDATE properties SET gcal_event_id=NULL WHERE uid=$1', [uid]);
      return;
    }
    if (action === 'update' || action === 'done') {
      await updateVisitEvent({ ...creds, eventId: p.gcal_event_id, property: p, assignedByEmail, assignedToEmail, summaryPrefix: action === 'done' ? '✅ DONE — ' : '' });
    }
  } catch (e) {
    const detail = e.errors || e.response?.data?.error || e.response?.data || '';
    console.error(`Calendar sync error [${action}] ${uid}:`, e.message, detail ? JSON.stringify(detail) : '');
  }
}

module.exports = { syncVisitCalendar, createVisitEvent, updateVisitEvent, deleteVisitEvent, diagnoseCalendar };
