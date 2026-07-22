// WhatsApp notification via Interakt API (Official WhatsApp Business API)
// All team data now pulled from users table in DB
const https = require('https');
const logger = require('./logger');

let _pool = null;
function init(pool) { _pool = pool; }

// ═══════════════════════════════════════════════════════
// DB LOOKUPS (replace hardcoded maps)
// ═══════════════════════════════════════════════════════

async function getPhone(name) {
  if (!name || !_pool) return null;
  try {
    const { rows } = await _pool.query(
      `SELECT phone FROM users WHERE LOWER(name)=LOWER($1) AND phone IS NOT NULL AND phone!='' AND is_active=TRUE LIMIT 1`,
      [name.trim()]
    );
    return rows.length ? rows[0].phone : null;
  } catch(e) { console.error('getPhone error:', e.message); return null; }
}

async function getTopManagers() {
  if (!_pool) return [];
  try {
    const { rows } = await _pool.query(`SELECT name FROM users WHERE is_top_manager=TRUE AND is_active=TRUE`);
    return rows.map(r => r.name).filter(Boolean);
  } catch(e) { console.error('getTopManagers error:', e.message); return []; }
}

async function getMidManagers() {
  if (!_pool) return {};
  try {
    const { rows } = await _pool.query(`SELECT name, managed_team FROM users WHERE is_manager=TRUE AND is_active=TRUE`);
    const map = {};
    rows.forEach(r => {
      if (r.name) {
        const team = typeof r.managed_team === 'string' ? JSON.parse(r.managed_team || '[]') : r.managed_team || [];
        if (team.length) map[r.name] = team;
      }
    });
    return map;
  } catch(e) { console.error('getMidManagers error:', e.message); return {}; }
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function nameMatch(a, b) {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Get all people who should receive a notification for this property
async function getRecipients(property, directRecipients) {
  const recipients = new Set();
  const involved = [
    property.assigned_by, property.field_exec, property.token_requested_by,
    ...directRecipients
  ].filter(Boolean);

  // 1. Direct recipients always get notified
  directRecipients.forEach(name => { if (name) recipients.add(name); });

  // 2. Top managers get everything
  const topMgrs = await getTopManagers();
  topMgrs.forEach(mgr => recipients.add(mgr));

  // 3. Mid managers get notified if any involved person is in their team
  const midMgrs = await getMidManagers();
  for (const [mgr, team] of Object.entries(midMgrs)) {
    const isInvolved = involved.some(name => nameMatch(name, mgr)) ||
                       involved.some(name => team.some(member => nameMatch(name, member)));
    if (isInvolved) recipients.add(mgr);
  }

  return [...recipients];
}

// Send template to multiple recipients, skip duplicates by phone
async function broadcastTemplate(templateName, bodyValues, recipients, ctx) {
  const sentPhones = new Set();
  const results = [];
  for (const name of recipients) {
    const phone = await getPhone(name);
    if (!phone) { console.log(`WA: No phone for "${name}", skipping`); continue; }
    if (sentPhones.has(phone)) { console.log(`WA: Already sent to ${phone} (${name}), skipping dupe`); continue; }
    sentPhones.add(phone);
    const ok = await sendInterakt(phone, templateName, bodyValues, ctx);
    results.push({ name, phone, ok });
  }
  return results;
}

// Log FIRST (so every wa_interakt_id row can carry log_id), then send, then fold the
// per-recipient outcomes back into that same activity_logs row.
async function sendAndLog(uid, templateName, logAction, bodyValues, recipients, actor) {
  const logId = await logger.logWhatsApp(uid, logAction, recipients, actor?.email, actor?.name);
  const results = await broadcastTemplate(templateName, bodyValues, recipients, { uid, logId });
  logger.updateWhatsAppResults(logId, results).catch(() => {});
  return results;
}

// ═══════════════════════════════════════════════════════
// INTERAKT API
// ═══════════════════════════════════════════════════════

// Persist the Interakt response id so deliveries can be reconciled with their webhook later.
// Fire-and-forget: a logging failure must never break sending a message.
function recordInteraktId(phone, templateName, rawBody, ctx) {
  if (!_pool) return;
  let result = null, msgId = null;
  try {
    const parsed = JSON.parse(rawBody);
    result = typeof parsed.result === 'boolean' ? parsed.result : null;
    msgId = parsed.id || null;
  } catch (e) { /* non-JSON error body — still record the attempt */ }
  // name is left out on purpose: the DB trigger fills it from users/properties.
  _pool.query(
    `INSERT INTO wa_interakt_id(phone, result, id, template, uid, log_id) VALUES($1,$2,$3,$4,$5,$6)`,
    [phone, result, msgId, templateName, ctx?.uid || null, ctx?.logId || null]
  ).catch(e => console.error('WA: failed to record interakt id:', e.message));
}

function sendInterakt(phone, templateName, bodyValues, ctx) {
  return new Promise((resolve) => {
    const apiKey = process.env.INTERAKT_API_KEY;
    if (!apiKey) { console.log('WA: INTERAKT_API_KEY not set, skipping'); return resolve(false); }
    if (!phone) { console.log('WA: No phone number, skipping'); return resolve(false); }

    const payload = JSON.stringify({
      countryCode: '+91',
      phoneNumber: phone,
      callbackData: 'openhouse_notify',
      type: 'Template',
      template: {
        name: templateName,
        languageCode: 'en',
        bodyValues: bodyValues
      }
    });

    console.log(`WA: Sending ${templateName} → ${phone}...`);

    const req = https.request({
      hostname: 'api.interakt.ai',
      path: '/v1/public/message/',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`WA: [${res.statusCode}] ${phone}: ${data.substring(0, 200)}`);
        // Interakt returns 201 Created on a queued message, so accept any 2xx.
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        recordInteraktId(phone, templateName, data, ctx);
        resolve(ok);
      });
    });
    req.on('error', e => { console.error('WA: Request error:', e.message); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════
// DATE/TIME HELPERS
// ═══════════════════════════════════════════════════════
function fmtDate(d) {
  if (!d) return '-';
  const dt = d instanceof Date ? d : new Date(d + 'T00:00');
  if (isNaN(dt)) return '-';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '-';
  const [h, m] = t.split(':');
  const hr = parseInt(h);
  return `${hr === 0 ? 12 : hr > 12 ? hr - 12 : hr}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
}

// ═══════════════════════════════════════════════════════
// NOTIFICATION FUNCTIONS
// ═══════════════════════════════════════════════════════

function notifyVisitScheduled(property, actor) {
  const p = property;
  const bodyValues = [p.uid||'-',fmtDate(p.schedule_date),fmtTime(p.schedule_time),p.field_exec||'-',p.assigned_by||'-',p.society_name||'-',p.tower_no||'-',p.unit_no||'-'];
  return getRecipients(p, [p.field_exec]).then(r => {
    console.log(`WA: visit_scheduled | UID: ${p.uid} | To: ${r.join(', ')}`);
    return sendAndLog(p.uid, 'visit_scheduled', 'visit_scheduled', bodyValues, r, actor);
  });
}

function notifyVisitCompleted(property, actor) {
  const p = property;
  const bodyValues = [p.uid||'-',p.society_name||'-',p.tower_no||'-',p.unit_no||'-',p.field_exec||'-',p.assigned_by||'-'];
  return getRecipients(p, [p.assigned_by]).then(r => {
    console.log(`WA: visit_completed_1v | UID: ${p.uid} | To: ${r.join(', ')}`);
    return sendAndLog(p.uid, 'visit_completed_1v', 'visit_completed_1v', bodyValues, r, actor);
  });
}

function notifyTokenRequest(property, actor) {
  const p = property;
  const amt = p.deal_token_amount!=null&&p.deal_token_amount!=='' ? '₹' + Number(p.deal_token_amount).toLocaleString('en-IN') : '-';
  const bodyValues = [p.uid||'-',amt,p.society_name||'-',p.tower_no||'-',p.unit_no||'-',p.token_requested_by||'-',p.owner_broker_name||'-'];
  return getRecipients(p, [p.assigned_by, p.token_requested_by, 'Saurabh']).then(r => {
    console.log(`WA: token_request | UID: ${p.uid} | To: ${r.join(', ')}`);
    return sendAndLog(p.uid, 'token_request_o8', 'token_request', bodyValues, r, actor);
  });
}

function notifyVisitReassigned(property, newExec, actor) {
  const p = property;
  const bodyValues = [p.uid||'-',fmtDate(p.schedule_date),fmtTime(p.schedule_time),newExec||'-',p.assigned_by||'-',p.society_name||'-',p.tower_no||'-',p.unit_no||'-'];
  return getRecipients(p, [newExec, p.assigned_by]).then(r => {
    console.log(`WA: visit_reassigned | UID: ${p.uid} | To: ${r.join(', ')}`);
    return sendAndLog(p.uid, 'visit_reassigned_2', 'visit_reassigned_2', bodyValues, r, actor);
  });
}

function notifyVisitCancelled(property, cancelledBy, actor) {
  const p = property;
  const bodyValues = [p.uid||'-',p.society_name||'-',p.tower_no||'-',p.unit_no||'-',cancelledBy||'-'];
  return getRecipients(p, [p.assigned_by, p.field_exec]).then(r => {
    console.log(`WA: visit_cancelled | UID: ${p.uid} | To: ${r.join(', ')}`);
    return sendAndLog(p.uid, 'visit_cancelled', 'visit_cancelled', bodyValues, r, actor);
  });
}

// Devishaa Patni — receives the same AMA WhatsApps as Akash Teotia (added by number so
// it works whether or not she's set up as a user). Added 24 Jun 2026.
const DEVISHAA = { name: 'Devishaa Patni', phone: '9217997423' };

async function notifyAMASubmitted(property, submitterName, actor) {
  const p = property;
  let dateStr = '-';
  if(p.deal_transfer_date){const dt=new Date(p.deal_transfer_date);dateStr=`${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`}
  const towerUnit = [p.tower_no, p.unit_no].filter(Boolean).join(' - ') || '-';
  const bdManager = p.assigned_by || '-';
  const bdPhone = await getPhone(bdManager) || '-';
  const bodyValues = [p.uid||'-', dateStr, p.society_name||'-', towerUnit, bdManager, bdPhone];
  // Fixed recipients: Saurabh, Akash Teotia + top managers + BD manager + submitter
  const topMgrs = await getTopManagers();
  const recipients = [...new Set(['Saurabh', 'Akash Teotia', 'Priyanshi Bajpai', ...topMgrs])];
  if(bdManager && bdManager!=='-') recipients.push(bdManager);
  if(submitterName && submitterName!=='-') recipients.push(submitterName);
  console.log(`WA: ama_notification | UID: ${p.uid} | To: ${recipients.join(', ')}, ${DEVISHAA.name}`);
  const waLogId = await logger.logWhatsApp(p.uid,'ama_notification',recipients,actor?.email,actor?.name);
  const waCtx = { uid: p.uid, logId: waLogId };
  const results = await broadcastTemplate('ama_notification', bodyValues, recipients, waCtx);
  // Devishaa Patni — guaranteed by number (alongside Akash Teotia), dedup-guarded
  if(!results.some(r=>r.phone===DEVISHAA.phone)){
    const ok = await sendInterakt(DEVISHAA.phone, 'ama_notification', bodyValues, waCtx);
    results.push({name:DEVISHAA.name, phone:DEVISHAA.phone, ok});
  }
  logger.updateWhatsAppResults(waLogId, results).catch(()=>{});
  return results;
}

// Deal Terms shared to owner — triggered on Form 4 email send
// Recipients: Top Managers, Submitter, Saurabh
// To add more recipients: add names to the recipients array below
async function notifyDealTermsShared(property, submitterName, actor) {
  const p = property;
  const gsp = p.guaranteed_sale_price ? '₹' + Number(p.guaranteed_sale_price).toLocaleString('en-IN') + ' Lakhs' : '-';
  const bodyValues = [p.uid||'-', p.society_name||'-', p.tower_no||'-', p.unit_no||'-', p.owner_broker_name||'-', p.co_owner||'-', gsp];
  const topMgrs = await getTopManagers();
  const recipients = [...new Set(['Saurabh', ...topMgrs])];
  if(submitterName && submitterName!=='-') recipients.push(submitterName);
  console.log(`WA: deal_terms_shared_to_owner | UID: ${p.uid} | To: ${recipients.join(', ')}`);
  const waLogId = await logger.logWhatsApp(p.uid,'deal_terms_shared_to_owner',recipients,actor?.email,actor?.name);
  const waCtx = { uid: p.uid, logId: waLogId };
  const results = await broadcastTemplate('deal_terms_shared_to_owner', bodyValues, recipients, waCtx);
  // Also notify owner, co-owner, CP directly
  const sentPhones = new Set(results.filter(r=>r.ok).map(r=>r.phone));
  const allRecipients = [...results];
  for(const ph of [p.contact_no, p.co_owner_number, p.cp_phone].filter(Boolean)){
    const clean = ph.replace(/\D/g,'').slice(-10);
    if(clean.length===10 && !sentPhones.has(clean)){
      sentPhones.add(clean);
      const ok = await sendInterakt(clean, 'deal_terms_shared_to_owner', bodyValues, waCtx);
      allRecipients.push({name:'direct',phone:clean,ok});
    }
  }
  logger.updateWhatsAppResults(waLogId, allRecipients).catch(()=>{});
  return results;
}

// AMA Signed / Pending Amount Request — triggered on Form 6 email send
// Recipients: Top Managers, Submitter, Saurabh, Akash Teotia, Amisha (9289996736)
// To add more recipients: add names to the recipients array below
// Template body vars: {{1}} uid, {{2}} society, {{3}} tower, {{4}} unit,
//                     {{5}} owner, {{6}} co-owner, {{7}} POC (assigned_by / BD manager)
async function notifyAMASigned(property, submitterName, actor) {
  const p = property;
  const bodyValues = [p.uid||'-', p.society_name||'-', p.tower_no||'-', p.unit_no||'-', p.owner_broker_name||'-', p.co_owner||'-', p.assigned_by||'-'];
  const topMgrs = await getTopManagers();
  const recipients = [...new Set(['Saurabh', 'Akash Teotia', ...topMgrs])];
  if(submitterName && submitterName!=='-') recipients.push(submitterName);
  console.log(`WA: ama_signed | UID: ${p.uid} | To: ${recipients.join(', ')}`);
  const waLogId = await logger.logWhatsApp(p.uid,'ama_signed',recipients,actor?.email,actor?.name);
  const waCtx = { uid: p.uid, logId: waLogId };
  const results = await broadcastTemplate('ama_signed', bodyValues, recipients, waCtx);
  const sentPhones = new Set(results.filter(r=>r.ok).map(r=>r.phone));
  const allRecipients = [...results];
  if(!sentPhones.has('9289996736')){sentPhones.add('9289996736');const ok=await sendInterakt('9289996736', 'ama_signed', bodyValues, waCtx);allRecipients.push({name:'Amisha',phone:'9289996736',ok})}
  if(!sentPhones.has(DEVISHAA.phone)){sentPhones.add(DEVISHAA.phone);const ok=await sendInterakt(DEVISHAA.phone, 'ama_signed', bodyValues, waCtx);allRecipients.push({name:DEVISHAA.name,phone:DEVISHAA.phone,ok})}
  for(const ph of [p.contact_no, p.co_owner_number, p.cp_phone].filter(Boolean)){
    const clean = ph.replace(/\D/g,'').slice(-10);
    if(clean.length===10 && !sentPhones.has(clean)){
      sentPhones.add(clean);
      const ok = await sendInterakt(clean, 'ama_signed', bodyValues, waCtx);
      allRecipients.push({name:'direct',phone:clean,ok});
    }
  }
  logger.updateWhatsAppResults(waLogId, allRecipients).catch(()=>{});
  return results;
}

// Key Handover — triggered on Form 7 email send
// Recipients: Top Managers, Submitter, Saurabh
// To add more recipients: add names to the recipients array below
async function notifyKeyHandover(property, submitterName, actor) {
  const p = property;
  const hdDate = p.key_handover_date ? fmtDate(p.key_handover_date) : '-';
  const bodyValues = [p.uid||'-', p.society_name||'-', p.tower_no||'-', p.unit_no||'-', hdDate];
  const topMgrs = await getTopManagers();
  const recipients = [...new Set(['Saurabh', ...topMgrs])];
  if(submitterName && submitterName!=='-') recipients.push(submitterName);
  console.log(`WA: key_handover | UID: ${p.uid} | To: ${recipients.join(', ')}`);
  const waLogId = await logger.logWhatsApp(p.uid,'key_handover',recipients,actor?.email,actor?.name);
  const waCtx = { uid: p.uid, logId: waLogId };
  const results = await broadcastTemplate('key_handover', bodyValues, recipients, waCtx);
  const sentPhones = new Set(results.filter(r=>r.ok).map(r=>r.phone));
  const allRecipients = [...results];
  // Fixed extra phone number
  const EXTRA_PHONE = '9560297049'; // Rajnish Sir Phone no - to receive key handover notifications for all properties
  if(!sentPhones.has(EXTRA_PHONE)){
    sentPhones.add(EXTRA_PHONE);
    const ok = await sendInterakt(EXTRA_PHONE, 'key_handover', bodyValues, waCtx);
    allRecipients.push({name:'Extra', phone:EXTRA_PHONE, ok});
  }
  for(const ph of [p.contact_no, p.co_owner_number, p.cp_phone].filter(Boolean)){
    const clean = ph.replace(/\D/g,'').slice(-10);
    if(clean.length===10 && !sentPhones.has(clean)){
      sentPhones.add(clean);
      const ok = await sendInterakt(clean, 'key_handover', bodyValues, waCtx);
      allRecipients.push({name:'direct',phone:clean,ok});
    }
  }
  logger.updateWhatsAppResults(waLogId, allRecipients).catch(()=>{});
  return results;
}

module.exports = {
  init, getPhone, getTopManagers, getMidManagers,
  sendInterakt, broadcastTemplate, getRecipients,
  notifyVisitScheduled, notifyVisitCompleted, notifyTokenRequest,
  notifyVisitReassigned, notifyVisitCancelled, notifyAMASubmitted,
  notifyDealTermsShared, notifyAMASigned, notifyKeyHandover
};