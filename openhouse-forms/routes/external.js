// External integrations — push from other Openhouse apps
const express = require('express'), router = express.Router();
const logger = require('../utils/logger');
const { notifyVisitScheduled, notifyVisitCancelled, notifyVisitReassigned } = require('../utils/whatsapp');
const { syncVisitCalendar } = require('../utils/calendar');
const { initHistory, setCancelled, addReschedule, dateStr } = require('../utils/visit-history');

const CITY_MAP = { 'Gurgaon': 'G', 'Noida': 'N', 'Ghaziabad': 'GH' };
const SRC_MAP = { 'CP': 'C', 'Direct': 'D', 'CP Listing': 'C' };

// Mandatory fields aligned with Form 1 (Visit Schedule)
const REQUIRED_FIELDS = [
  'lead_id', 'city', 'source', 'schedule_date', 'schedule_time',
  'first_name', 'contact_no', 'society_name', 'locality',
  'area_sqft', 'configuration', 'assigned_by', 'field_exec'
];

function authCheck(req, res, next) {
  const key = req.headers['x-internal-key'];
  if (!process.env.INTERNAL_API_KEY) {
    return res.status(500).json({ error: 'INTERNAL_API_KEY not configured on server' });
  }
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing X-Internal-Key' });
  }
  next();
}

module.exports = function (pool) {

  // POST /api/external/schedule — create a visit schedule from another app
  router.post('/schedule', authCheck, async (req, res) => {
    try {
      const d = req.body || {};

      // 1. Validate mandatory fields
      const missing = REQUIRED_FIELDS.filter(f => d[f] === undefined || d[f] === null || d[f] === '');
      if (missing.length) {
        return res.status(400).json({ error: 'Missing required fields', missing });
      }

      // 2. Validate city + source map to known prefixes
      const ci = CITY_MAP[d.city];
      const si = SRC_MAP[d.source];
      if (!ci) return res.status(400).json({ error: `Unsupported city: ${d.city}. Allowed: ${Object.keys(CITY_MAP).join(', ')}` });
      if (!si) return res.status(400).json({ error: `Unsupported source: ${d.source}. Allowed: ${Object.keys(SRC_MAP).join(', ')}` });

      // 3. Validate phone (10 digits, no leading 0)
      const phone = String(d.contact_no).replace(/\D/g, '');
      if (phone.length !== 10 || phone.startsWith('0')) {
        return res.status(400).json({ error: 'contact_no must be 10 digits with no leading 0' });
      }

      // 4. Validate date not in past
      const today = new Date().toISOString().split('T')[0];
      if (d.schedule_date < today) {
        return res.status(400).json({ error: 'schedule_date cannot be in the past' });
      }

      // 5. Validate assigned_by + field_exec exist in users table (case-insensitive)
      const { rows: usersRows } = await pool.query(
        `SELECT name FROM users WHERE LOWER(name) = ANY($1) AND is_active = TRUE`,
        [[String(d.assigned_by).toLowerCase(), String(d.field_exec).toLowerCase()]]
      );
      const validNames = new Set(usersRows.map(r => r.name.toLowerCase()));
      if (!validNames.has(String(d.assigned_by).toLowerCase())) {
        return res.status(400).json({ error: `assigned_by '${d.assigned_by}' is not an active user in Forms app` });
      }
      if (!validNames.has(String(d.field_exec).toLowerCase())) {
        return res.status(400).json({ error: `field_exec '${d.field_exec}' is not an active user in Forms app` });
      }

      // 6. IDEMPOTENCY — check if this lead_id already has a schedule
      const existing = await pool.query(
        'SELECT uid FROM properties WHERE lead_id = $1 LIMIT 1',
        [String(d.lead_id)]
      );
      if (existing.rows.length) {
        return res.json({
          success: true,
          uid: existing.rows[0].uid,
          already_existed: true
        });
      }

      // 7. Slot conflict check — same as Form 1 (30-min window per visit)
      const [sh, sm] = String(d.schedule_time).split(':').map(Number);
      if (isNaN(sh) || isNaN(sm)) {
        return res.status(400).json({ error: 'schedule_time must be in HH:MM format' });
      }
      const selMin = sh * 60 + sm;
      const { rows: busy } = await pool.query(
        `SELECT schedule_time, uid, society_name, unit_no, tower_no FROM properties
         WHERE field_exec = $1 AND schedule_date = $2
         AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE AND replicated IS NOT TRUE`,
        [d.field_exec, d.schedule_date]
      );
      const windows = busy.map(r => {
        const [h, m] = r.schedule_time.split(':').map(Number);
        const s = h * 60 + m;
        return { start: s, end: s + 30, time: r.schedule_time, uid: r.uid, society: r.society_name, unit: r.unit_no, tower: r.tower_no };
      });
      const newEnd = selMin + 30;
      const hit = windows.find(w => selMin < w.end && newEnd > w.start);
      if (hit) {
        const fmt = m => {
          const h = Math.floor(m / 60), mm = m % 60;
          return `${h > 12 ? h - 12 : h === 0 ? 12 : h}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
        };
        const sorted = [...windows].sort((a, b) => a.start - b.start);
        // A 30-min slot starting at t is free if it sits in business hours (8 AM–8 PM)
        // and overlaps none of the booked windows. Collect up to 3 on each side.
        const free = t => t >= 8 * 60 && t <= 20 * 60 && !sorted.some(w => t < w.end && t + 30 > w.start);
        const before = [];
        for (let t = selMin - 30; t >= 8 * 60 && before.length < 3; t -= 30) if (free(t)) before.push(t);
        const after = [];
        for (let t = selMin + 30; t <= 20 * 60 && after.length < 3; t += 30) if (free(t)) after.push(t);
        // chronological: earliest before-slots first, then the after-slots
        const suggestions = [...before.reverse(), ...after].map(fmt);
        return res.status(409).json({
          error: 'Slot conflict',
          message: `${d.field_exec} is already booked at ${hit.time} (${hit.society} ${hit.tower || ''}${hit.unit ? '-' + hit.unit : ''}). Conflicting UID: ${hit.uid}`,
          conflict: { uid: hit.uid, time: hit.time, society: hit.society, tower: hit.tower, unit: hit.unit, field_exec: d.field_exec, schedule_date: d.schedule_date },
          suggested_times: suggestions
        });
      }

      // 8. Generate UID using same logic as schedule.js
      const prefix = `OH${ci}${si}`;
      const { rows: maxRows } = await pool.query(
        `SELECT MAX(CAST(REPLACE(uid, $1, '') AS INTEGER)) AS max_num FROM properties WHERE uid LIKE $2`,
        [prefix, prefix + '%']
      );
      const next = (maxRows[0].max_num || 1000) + 1;
      const uid = prefix + String(next);

      // 9. Build owner name
      const ownerName = [d.first_name, d.last_name].filter(Boolean).join(' ');

      // 10. Insert property row
      await pool.query(`INSERT INTO properties(
          uid, schedule_date, schedule_time, lead_id, source,
          first_name, last_name, owner_broker_name, contact_no,
          area_sqft, demand_price, city, society_name, locality,
          unit_no, tower_no, floor, configuration,
          assigned_by, field_exec, visit_date_history, schedule_submitted_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())`,
        [uid, d.schedule_date, d.schedule_time, String(d.lead_id), d.source,
         d.first_name, d.last_name || null, ownerName, phone,
         parseFloat(d.area_sqft) || null, parseFloat(d.demand_price) || null,
         d.city, d.society_name, d.locality,
         d.unit_no || null, d.tower_no || null,
         d.floor || null, d.configuration,
         d.assigned_by, d.field_exec, JSON.stringify(initHistory(d.schedule_date))]
      );

      // 11. Respond immediately
      res.json({ success: true, uid, already_existed: false });

      // 12. Resolve actor for logs/WA — use provided actor_email if given, else null (don't fabricate)
      const actorEmail = d.actor_email || null;
      const actorName = d.actor_name || 'CP Listings App';

      // 13. Fire-and-forget logging
      logger.log(uid, 'schedule_submitted_via_external', 'form',
        actorEmail, actorName,
        { source_app: 'CP Listings', lead_id: String(d.lead_id), form: 'schedule', form_number: 1 }
      ).catch(() => {});

      // 14. Fire-and-forget WhatsApp notification (same as form submit)
      notifyVisitScheduled(
        { uid, ...d, owner_broker_name: ownerName },
        { email: actorEmail, name: actorName }
      ).catch(e => console.error('External WA notify error:', e));

      // 15. Fire-and-forget Google Calendar event — no session here, so the orchestrator
      //     falls back to assigned_by / field_exec as the event creator.
      syncVisitCalendar(pool, { uid, action: 'create' }).catch(e => console.error('External cal sync error:', e));

    } catch (e) {
      console.error('External /schedule error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/external/cancel — cancel a previously-scheduled visit from another app.
  // Mirrors the in-app /api/visits/dead/:uid handler: marks is_dead=TRUE and fires the
  // visit-cancelled WhatsApp. Idempotent — re-cancelling an already-dead row is a no-op.
  router.post('/cancel', authCheck, async (req, res) => {
    try {
      const d = req.body || {};
      const leadId = d.lead_id ? String(d.lead_id) : '';
      if (!leadId) return res.status(400).json({ error: 'lead_id required' });

      const { rows } = await pool.query(
        'SELECT * FROM properties WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1',
        [leadId]
      );
      if (!rows.length) return res.status(404).json({ error: `no visit found for lead_id ${leadId}` });
      const prop = rows[0];

      if (prop.is_dead) {
        return res.json({ success: true, uid: prop.uid, already_cancelled: true });
      }
      if (prop.visit_submitted_at) {
        return res.status(400).json({ error: 'visit already completed, cannot cancel' });
      }

      await pool.query(
        'UPDATE properties SET is_dead = TRUE, visit_date_history = $2, updated_at = NOW() WHERE uid = $1',
        [prop.uid, JSON.stringify(setCancelled(prop.visit_date_history, prop.schedule_date))]
      );
      res.json({ success: true, uid: prop.uid, already_cancelled: false });

      const actorEmail   = d.actor_email || null;
      const actorName    = d.actor_name  || 'External API';
      // "Cancelled from" is whatever the calling app sends — never hardcoded.
      const cancelledFrom = d.cancelled_from || d.source_app || 'External';
      const reason       = d.reason || '';

      logger.logStatusChange(prop.uid, 'visit_cancelled_via_external', false, true, actorEmail, actorName).catch(() => {});
      // Always record where the cancel came from (+ optional reason), so it shows in the activity log.
      logger.log(prop.uid, 'visit_cancel_reason', 'note', actorEmail, actorName,
        { cancelled_from: cancelledFrom, reason: reason || null }).catch(() => {});
      notifyVisitCancelled(prop, actorName, { email: actorEmail, name: actorName }).catch(e => console.error('External WA cancel notify error:', e));
      // Remove the calendar event (uses the stored creator's token)
      syncVisitCalendar(pool, { uid: prop.uid, action: 'delete' }).catch(e => console.error('External cal cancel sync error:', e));
    } catch (e) {
      console.error('External /cancel error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/external/reschedule — change a scheduled visit's date/time from another app.
  // Mirrors the in-app /api/visits/reschedule/:uid: records the old date in visit history,
  // updates the calendar event, and logs who/where the change came from.
  router.post('/reschedule', authCheck, async (req, res) => {
    try {
      const d = req.body || {};
      const leadId  = d.lead_id ? String(d.lead_id) : '';
      const newDate = d.schedule_date || '';
      const newTime = d.schedule_time || '';
      if (!leadId)  return res.status(400).json({ error: 'lead_id required' });
      if (!newDate) return res.status(400).json({ error: 'schedule_date required' });
      if (!newTime) return res.status(400).json({ error: 'schedule_time required' });
      const [sh, sm] = String(newTime).split(':').map(Number);
      if (isNaN(sh) || isNaN(sm)) return res.status(400).json({ error: 'schedule_time must be in HH:MM format' });
      const today = new Date().toISOString().split('T')[0];
      if (newDate < today) return res.status(400).json({ error: 'schedule_date cannot be in the past' });

      const { rows } = await pool.query(
        'SELECT * FROM properties WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1',
        [leadId]
      );
      if (!rows.length) return res.status(404).json({ error: `no visit found for lead_id ${leadId}` });
      const prop = rows[0];
      if (prop.is_dead)            return res.status(400).json({ error: 'visit is cancelled, cannot reschedule' });
      if (prop.visit_submitted_at) return res.status(400).json({ error: 'visit already completed, cannot reschedule' });

      // Optional field-exec change. When sent, it must be an active user (same rule as /schedule).
      const newExec = d.field_exec ? String(d.field_exec).trim() : '';
      if (newExec) {
        const { rows: u } = await pool.query(
          'SELECT 1 FROM users WHERE LOWER(name) = LOWER($1) AND is_active = TRUE LIMIT 1', [newExec]
        );
        if (!u.length) return res.status(400).json({ error: `field_exec '${newExec}' is not an active user in Forms app` });
      }
      const execChanged = newExec && newExec.toLowerCase() !== String(prop.field_exec || '').toLowerCase();
      const finalExec = newExec || prop.field_exec;

      // Record the old date in the history only when the date actually changes (matches in-app behaviour)
      const dateChanged = dateStr(prop.schedule_date) !== dateStr(newDate);
      const newHist = dateChanged ? JSON.stringify(addReschedule(prop.visit_date_history, prop.schedule_date, newDate)) : null;
      await pool.query(
        'UPDATE properties SET schedule_date = $1, schedule_time = $2, field_exec = $5, visit_date_history = COALESCE($4, visit_date_history), updated_at = NOW() WHERE uid = $3',
        [newDate, newTime, prop.uid, newHist, finalExec]
      );
      res.json({ success: true, uid: prop.uid, schedule_date: newDate, schedule_time: newTime, field_exec: finalExec });

      const actorEmail    = d.actor_email || null;
      const actorName     = d.actor_name  || 'External API';
      const rescheduledFrom = d.rescheduled_from || d.source_app || 'External';

      logger.logScheduleChange(prop.uid, 'visit_rescheduled_via_external',
        { old_date: prop.schedule_date, new_date: newDate, old_time: prop.schedule_time, new_time: newTime,
          old_field_exec: prop.field_exec, new_field_exec: finalExec, rescheduled_from: rescheduledFrom },
        actorEmail, actorName).catch(() => {});
      if (execChanged) {
        logger.logAssignment(prop.uid, 'visit_reassigned_via_external', prop.field_exec, finalExec, actorEmail, actorName, rescheduledFrom).catch(() => {});
      }
      // Update the Google Calendar event (time + attendees, since the exec may have changed)
      syncVisitCalendar(pool, { uid: prop.uid, action: 'update' }).catch(e => console.error('External cal reschedule sync error:', e));
      // Notify the (possibly new) assignee. Reassign template when the exec changed, else the schedule one.
      const notifyProp = { ...prop, schedule_date: newDate, schedule_time: newTime, field_exec: finalExec };
      if (execChanged) {
        notifyVisitReassigned(notifyProp, finalExec, { email: actorEmail, name: actorName }).catch(e => console.error('External WA reassign notify error:', e));
      } else {
        notifyVisitScheduled(notifyProp, { email: actorEmail, name: actorName }).catch(e => console.error('External WA reschedule notify error:', e));
      }
    } catch (e) {
      console.error('External /reschedule error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};