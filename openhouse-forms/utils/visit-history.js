// Consolidated date audit trail for a visit, stored in properties.visit_date_history (JSONB):
//   { scheduled_date, reschedules: [{old_date,new_date,on}], cancelled_on }
// The live/current visit date stays in the schedule_date column (not duplicated here).

// pg returns a DATE column as a JS Date; normalize anything to 'YYYY-MM-DD'.
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).split('T')[0];
}

function initHistory(scheduleDate) {
  return { scheduled_date: dateStr(scheduleDate), reschedules: [] };
}

// Append a reschedule entry (backfills scheduled_date for rows created before this feature).
function addReschedule(history, oldDate, newDate) {
  const h = history && typeof history === 'object' ? { ...history } : {};
  if (!h.scheduled_date) h.scheduled_date = dateStr(oldDate);
  h.reschedules = Array.isArray(h.reschedules) ? [...h.reschedules] : [];
  h.reschedules.push({ old_date: dateStr(oldDate), new_date: dateStr(newDate), on: new Date().toISOString() });
  return h;
}

function setCancelled(history, scheduleDate) {
  const h = history && typeof history === 'object' ? { ...history } : {};
  if (!h.scheduled_date && scheduleDate) h.scheduled_date = dateStr(scheduleDate);
  h.cancelled_on = new Date().toISOString();
  return h;
}

module.exports = { dateStr, initHistory, addReschedule, setCancelled };
