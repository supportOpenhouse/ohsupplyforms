const express=require('express'),router=express.Router();
const logger=require('../utils/logger');
const{visibilityFilter}=require('../utils/visibility');
const{sendCPBillEmail}=require('../utils/email-sender');
const cpPool=require('../db/cpPool');

// ── The CP-app cutover ──
// Sourcing bills are raised from ONE place per property, decided by when its Token
// Request MAIL actually went out:
//   before CUTOVER -> this internal form
//   on/after       -> the Channel Partner app, through the CRM relay
// so the same bill can never be raised from both sides.
//
// The anchor is `activity_logs.email_token_request` (written by utils/logger
// logEmailSent when the mail is sent, once, never rewritten) — NOT
// properties.token_submitted_at, which tracks the LATEST Form-3 submission and so
// moves forward on a resubmission. That column let a 12-Sep property read as 21 Sep
// and be billed from both sides; the CRM relay anchors on the same log for the same
// reason. MIN() is deliberate: the FIRST mail is when the deal entered the world, so
// a resend must not move the anchor either.
//
// A property with NO such log predates the logging (they were billed Apr-May), so it
// belongs to the form era and stays visible. The relay excludes those already,
// because a missing timestamp fails its `>= cutoff` test.
const CP_APP_CUTOVER = (process.env.RELAY_MIN_TOKEN_DATE || '2026-09-18').trim();

// Hide a property from this form once its token mail is on/after the cutover.
// Written as an anti-join, NOT a per-row correlated subquery: this aggregates the
// 532 email_token_request rows ONCE via idx_logs_action (bitmap scan, 4.5ms over
// 123k log rows), where a correlated version would re-run per candidate property.
// Requires the caller to alias `properties` as `p`.
const CUTOVER_CLAUSE = CP_APP_CUTOVER ? `
      AND p.uid NOT IN (
        SELECT a.uid FROM activity_logs a
         WHERE a.action = 'email_token_request'
         GROUP BY a.uid
        HAVING min(a.created_at) >= '${CP_APP_CUTOVER}'::date)` : '';

// Is this property still the FORM's to bill? The dropdown filter above is only the
// UI; prefill/submit/send-email are reachable directly (a bookmarked ?uid=, a stale
// tab), so the rule is enforced here too. Same anchor, same reason.
async function formEraOk(pool, uid){
  if(!CP_APP_CUTOVER) return true;
  const{rows}=await pool.query(
    `SELECT min(created_at) AS at FROM activity_logs
      WHERE uid=$1 AND action='email_token_request'`,[uid]);
  const at=rows[0]&&rows[0].at;
  // No token-mail log at all => predates the logging => form era. The relay
  // excludes those anyway, since a missing timestamp fails its `>= cutoff` test.
  if(!at) return true;
  return new Date(at) < new Date(`${CP_APP_CUTOVER}T00:00:00`);
}

const CUTOVER_MSG = uid =>
  `${uid}'s Token Request email went out on or after ${CP_APP_CUTOVER}, so its `
  + `sourcing bill is raised by the Channel Partner in the CP app, not here.`;

module.exports=function(pool){
  // ── CP code for a NEW cp ──
  // Codes are owned by the shared channel_partners directory now. Supply used to
  // mint its own CP00xx here (max(id)+1), which resolved to nothing in the
  // directory and even collided within supply — CP0130 sat on two different
  // people. A CP that is not in the directory simply has no code until it is
  // onboarded there; name + phone still identify them, and phone is the key every
  // downstream system matches on.
  router.get('/cp-master/next-code',async(_req,res)=>{
    res.json({cp_code:null});
  });

  // ── CP search — the SHARED channel_partners directory ──
  // Columns are aliased to the names the form already uses (cp_name / cp_firm /
  // cp_pan_card_url), so the picker markup and JS stay unchanged.
  router.get('/cp-master/search',async(req,res)=>{
    try{
      const q=(req.query.q||'').trim();
      if(!q)return res.json([]);
      if(!cpPool)return res.status(503).json({error:'CP directory is not configured on this server'});
      const digits=q.replace(/\D/g,'');
      const{rows}=await cpPool.query(
        `SELECT id, cp_code, name AS cp_name, phone AS cp_phone,
                company AS cp_firm, email AS cp_email
           FROM channel_partners
          WHERE is_active IS NOT FALSE
            AND (cp_code ILIKE $1 OR name ILIKE $1 OR company ILIKE $1
                 OR ($2 <> '' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') LIKE '%'||$2||'%'))
          ORDER BY name ASC LIMIT 20`,
        ['%'+q+'%', digits]);
      res.json(rows);
    }catch(e){res.status(500).json({error:e.message})}
  });

  // ── CP full record — the SHARED directory ──
  // `cp_pan_url` is the directory's name for what supply calls `cp_pan_card_url`;
  // aliasing here keeps importCp() in cp-bill.html working untouched.
  router.get('/cp-master/:id',async(req,res)=>{
    try{
      if(!cpPool)return res.status(503).json({error:'CP directory is not configured on this server'});
      const{rows}=await cpPool.query(
        `SELECT id, cp_code, name AS cp_name, phone AS cp_phone,
                company AS cp_firm, email AS cp_email,
                cp_aadhaar_front_url, cp_aadhaar_back_url,
                cp_pan_url AS cp_pan_card_url, cp_cancelled_cheque_url,
                cp_gst_invoice_url, cp_coi_url
           FROM channel_partners WHERE id=$1`,[req.params.id]);
      if(!rows.length)return res.status(404).json({error:'CP not found'});
      res.json(rows[0]);
    }catch(e){res.status(500).json({error:e.message})}
  });

  router.get('/prefill/:uid',async(req,res)=>{
    try{const{rows}=await pool.query(`SELECT p.*,
        (SELECT email FROM users WHERE LOWER(name)=LOWER(p.assigned_by) AND is_active=TRUE LIMIT 1) AS assigned_by_email,
        (SELECT email FROM users WHERE LOWER(name)=LOWER(p.token_requested_by) AND is_active=TRUE LIMIT 1) AS token_requested_by_email
      FROM properties p WHERE p.uid=$1`,[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      const p=rows[0];if(!p.pending_request_submitted_at)return res.status(400).json({error:'AMA Acknowledgement (Form 6) must be submitted first'});
      if(!await formEraOk(pool,req.params.uid))
        return res.status(409).json({error:CUTOVER_MSG(req.params.uid)});
      res.json(p)}catch(e){res.status(500).json({error:e.message})}
  });
  router.get('/uids',async(req,res)=>{
    try{const vis=visibilityFilter(req.user);const{rows}=await pool.query(`SELECT p.uid,p.city,p.society_name,p.unit_no,p.tower_no,p.owner_broker_name,p.final_submitted_at,p.cp_bill_submitted_at
      FROM properties p WHERE p.pending_request_submitted_at IS NOT NULL AND p.is_dead IS NOT TRUE AND p.is_token_refunded IS NOT TRUE AND p.replicated IS NOT TRUE AND p.uid !~ '^OH[A-Z]*D[0-9]'${CUTOVER_CLAUSE}${vis.clause} ORDER BY p.updated_at DESC`,vis.params);res.json(rows)}catch(e){res.status(500).json({error:e.message})}
  });
  router.post('/submit',async(req,res)=>{
    try{
      const d=req.body;const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[d.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      if(!await formEraOk(pool,d.uid))
        return res.status(409).json({error:CUTOVER_MSG(d.uid)});
      const oldRow=rows[0];const wasSubmitted=!!oldRow.cp_bill_submitted_at;

      // Resolve the CP against the SHARED directory so properties.cp_code holds a
      // code that actually maps. Two paths:
      //   picked from the directory -> cp_master_id is its channel_partners.id
      //   typed by hand             -> match on PHONE (last 10), the only reliable
      //                                key across the two systems
      // The local cp_master table is no longer written: its CP00xx codes are a
      // separate numbering scheme that resolves to nothing in the directory, and
      // it minted them as max(id)+1, so the same code landed on different people.
      let cpCode=null, cpDirectoryId=null;
      if(cpPool&&(d.cp_master_id||d.cp_phone)){
        try{
          const p10=String(d.cp_phone||'').replace(/\D/g,'').slice(-10);
          const{rows:dir}=d.cp_master_id
            ? await cpPool.query('SELECT id,cp_code FROM channel_partners WHERE id=$1',[d.cp_master_id])
            : await cpPool.query(
                `SELECT id,cp_code FROM channel_partners
                  WHERE right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=$1
                  ORDER BY id DESC LIMIT 1`,[p10]);
          if(dir.length){cpCode=dir[0].cp_code;cpDirectoryId=dir[0].id}
        }catch(e){console.error('CP directory lookup failed:',e.message)}
      }
      // The four KYC documents uploaded here belong to the PARTNER, not to this
      // one property, so push them onto the resolved directory row — that is what
      // the CRM's KYC review reads and what a generated invoice pulls from. Note
      // the directory calls the PAN column `cp_pan_url`, supply calls it
      // `cp_pan_card_url`.
      //
      // Fill-if-empty (COALESCE/NULLIF), never overwrite: a document already on the
      // directory has usually been through KYC review, and a later bill form must
      // not silently replace it. `cp_kyc_status` is deliberately untouched — the
      // CRM's review flow owns it, and writing a doc is not an approval.
      if(cpPool&&cpDirectoryId){
        try{
          await cpPool.query(
            `UPDATE channel_partners SET
               cp_aadhaar_front_url=COALESCE(NULLIF(cp_aadhaar_front_url,''),NULLIF($1,'')),
               cp_aadhaar_back_url =COALESCE(NULLIF(cp_aadhaar_back_url,''),NULLIF($2,'')),
               cp_pan_url          =COALESCE(NULLIF(cp_pan_url,''),NULLIF($3,'')),
               cp_cancelled_cheque_url=COALESCE(NULLIF(cp_cancelled_cheque_url,''),NULLIF($4,'')),
               cp_gst_invoice_url  =COALESCE(NULLIF(cp_gst_invoice_url,''),NULLIF($5,'')),
               cp_coi_url          =COALESCE(NULLIF(cp_coi_url,''),NULLIF($6,''))
             WHERE id=$7`,
            [d.cp_aadhaar_front_url||'',d.cp_aadhaar_back_url||'',
             d.cp_pan_card_url||'',d.cp_cancelled_cheque_url||'',
             d.cp_gst_invoice_url||'',d.cp_coi_url||'',cpDirectoryId]);
        }catch(e){
          // Never fail the bill submission over the directory — the documents are
          // still saved on the property below.
          console.error('CP directory doc sync failed:',e.message);
        }
      }

      // Unresolved (directory down, or a CP not in it yet) leaves cp_code NULL
      // rather than writing a code that maps to nobody — name and phone are still
      // saved, and the phone is what every downstream system matches on anyway.

      await pool.query(`UPDATE properties SET
        cp_code=$19,cp_name=$1,cp_phone=$2,cp_firm=$3,cp_email=$4,
        deal_type=$5,oh_acquired_model=$6,agreed_brokerage=$7,
        deal_value=$8,total_brokerage_amount=$9,
        incentive_visit=$10,incentive_owner_meeting=$11,total_cp_amount=$12,to_be_released_now=$13,
        cp_aadhaar_front_url=$14,cp_aadhaar_back_url=$15,
        cp_pan_card_url=$16,cp_cancelled_cheque_url=$17,
        gst_applicable=$20,cp_gst_invoice_url=$21,cp_coi_url=$22,cp_bill_remarks=$23,
        brokerage_ama_signed=$24,brokerage_ama_signed_amount=$25,brokerage_registry=$26,brokerage_registry_amount=$27,
        additional_brokerage=$28,
        cp_bill_submitted_at=NOW(),updated_at=NOW()
        WHERE uid=$18`,
        [d.cp_name||null,d.cp_phone||null,d.cp_firm||null,d.cp_email||null,
         d.deal_type||null,d.oh_acquired_model||null,d.agreed_brokerage||null,
         d.deal_value||null,d.total_brokerage_amount||null,
         d.incentive_visit||null,d.incentive_owner_meeting||null,d.total_cp_amount||null,d.to_be_released_now||null,
         d.cp_aadhaar_front_url||null,d.cp_aadhaar_back_url||null,
         d.cp_pan_card_url||null,d.cp_cancelled_cheque_url||null,
         d.uid,cpCode,d.gst_applicable||'No',d.cp_gst_invoice_url||null,d.cp_coi_url||null,d.cp_bill_remarks||null,
         d.brokerage_ama_signed||null,d.brokerage_ama_signed_amount||null,d.brokerage_registry||null,d.brokerage_registry_amount||null,
         d.additional_brokerage||null]);
      res.json({success:true,uid:d.uid,cp_code:cpCode});
      pool.query('SELECT * FROM properties WHERE uid=$1',[d.uid]).then(({rows:nu})=>
        logger.logFormSubmit(d.uid,'cp_bill_submitted',8,req.user?.email,req.user?.name,{wasSubmitted,oldRow,newRow:nu[0]})).catch(()=>{});
    }catch(e){console.error('CPBill:',e);res.status(500).json({error:e.message})}
  });
  router.post('/send-email/:uid',async(req,res)=>{
    try{
      const userId=req.user?.id;
      if(!userId)return res.status(401).json({error:'Not authenticated'});
      if(!await formEraOk(pool,req.params.uid))
        return res.status(409).json({error:CUTOVER_MSG(req.params.uid)});
      const{rows:uRows}=await pool.query('SELECT email,name,google_access_token,google_refresh_token FROM users WHERE id=$1',[userId]);
      if(!uRows.length)return res.status(401).json({error:'User not found'});
      const user=uRows[0];
      if(!user.google_access_token&&!user.google_refresh_token){
        return res.status(400).json({error:'Gmail not authorized. Please log out and log in again.'});
      }
      const{rows:pRows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!pRows.length)return res.status(404).json({error:'Property not found'});
      const p=pRows[0];
      if(!p.cp_bill_submitted_at)return res.status(400).json({error:'CP Bill form must be submitted first'});
      if(p.cp_bill_email_sent===true&&!(req.body&&req.body.force))return res.status(409).json({error:'Email Sent Already',alreadySent:true});
      const result=await sendCPBillEmail({
        accessToken:user.google_access_token,refreshToken:user.google_refresh_token,
        fromEmail:user.email,senderName:user.name||user.email,property:p
      });
      await pool.query('UPDATE properties SET cp_bill_email_sent=TRUE,updated_at=NOW() WHERE uid=$1',[req.params.uid]);
      console.log(`CP Bill email sent for ${req.params.uid} by ${user.email} — msgId: ${result.messageId}`);
      res.json({success:true,messageId:result.messageId});
    }catch(e){
      console.error('CPBillEmail:',e);
      if(e.message?.includes('invalid_grant')||e.message?.includes('Token has been expired')||e.code===401){
        return res.status(401).json({error:'Gmail token expired. Please log out and log in again.'});
      }
      res.status(500).json({error:e.message||'Failed to send email'});
    }
  });
  return router;
};