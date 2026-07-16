const express=require('express'),router=express.Router();
const logger=require('../utils/logger');
const{visibilityFilter}=require('../utils/visibility');
const{sendCPBillEmail}=require('../utils/email-sender');

module.exports=function(pool){
  // ── CP Master: next code ──
  router.get('/cp-master/next-code',async(req,res)=>{
    try{
      const{rows}=await pool.query(`SELECT cp_code FROM cp_master ORDER BY id DESC LIMIT 1`);
      let next=1;
      if(rows.length){const last=rows[0].cp_code;const num=parseInt(last.replace('CP',''))||0;next=num+1}
      const code='CP'+String(next).padStart(4,'0');
      res.json({cp_code:code});
    }catch(e){res.status(500).json({error:e.message})}
  });

  // ── CP Master: search ──
  router.get('/cp-master/search',async(req,res)=>{
    try{
      const q=(req.query.q||'').trim();
      if(!q)return res.json([]);
      const{rows}=await pool.query(
        `SELECT id,cp_code,cp_name,cp_phone,cp_firm,cp_email FROM cp_master
         WHERE cp_code ILIKE $1 OR cp_name ILIKE $1 OR cp_phone ILIKE $1 OR cp_firm ILIKE $1
         ORDER BY cp_name ASC LIMIT 20`,
        ['%'+q+'%']);
      res.json(rows);
    }catch(e){res.status(500).json({error:e.message})}
  });

  // ── CP Master: get full record ──
  router.get('/cp-master/:id',async(req,res)=>{
    try{
      const{rows}=await pool.query('SELECT * FROM cp_master WHERE id=$1',[req.params.id]);
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
      res.json(p)}catch(e){res.status(500).json({error:e.message})}
  });
  router.get('/uids',async(req,res)=>{
    try{const vis=visibilityFilter(req.user);const{rows}=await pool.query(`SELECT uid,city,society_name,unit_no,tower_no,owner_broker_name,final_submitted_at,cp_bill_submitted_at
      FROM properties WHERE pending_request_submitted_at IS NOT NULL AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE AND replicated IS NOT TRUE AND uid !~ '^OH[A-Z]*D[0-9]'${vis.clause} ORDER BY updated_at DESC`,vis.params);res.json(rows)}catch(e){res.status(500).json({error:e.message})}
  });
  router.post('/submit',async(req,res)=>{
    try{
      const d=req.body;const{rows}=await pool.query('SELECT uid FROM properties WHERE uid=$1',[d.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});

      // Upsert CP master record
      let cpCode=d.cp_code||null;
      if(d.cp_name&&d.cp_phone){
        if(d.cp_master_id){
          // Existing CP — update docs if new ones uploaded
          await pool.query(`UPDATE cp_master SET
            cp_name=COALESCE(NULLIF($1,''),cp_name),cp_phone=COALESCE(NULLIF($2,''),cp_phone),
            cp_firm=COALESCE(NULLIF($3,''),cp_firm),cp_email=COALESCE(NULLIF($4,''),cp_email),
            cp_aadhaar_front_url=COALESCE(NULLIF($5,''),cp_aadhaar_front_url),
            cp_aadhaar_back_url=COALESCE(NULLIF($6,''),cp_aadhaar_back_url),
            cp_pan_card_url=COALESCE(NULLIF($7,''),cp_pan_card_url),
            cp_cancelled_cheque_url=COALESCE(NULLIF($8,''),cp_cancelled_cheque_url),
            updated_at=NOW() WHERE id=$9`,
            [d.cp_name,d.cp_phone,d.cp_firm||'',d.cp_email||'',
             d.cp_aadhaar_front_url||'',d.cp_aadhaar_back_url||'',d.cp_pan_card_url||'',d.cp_cancelled_cheque_url||'',
             d.cp_master_id]);
        }else if(cpCode){
          // New CP — insert
          await pool.query(`INSERT INTO cp_master(cp_code,cp_name,cp_phone,cp_firm,cp_email,
            cp_aadhaar_front_url,cp_aadhaar_back_url,cp_pan_card_url,cp_cancelled_cheque_url)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT(cp_code) DO UPDATE SET cp_name=$2,cp_phone=$3,cp_firm=COALESCE(NULLIF($4,''),cp_master.cp_firm),
            cp_email=COALESCE(NULLIF($5,''),cp_master.cp_email),
            cp_aadhaar_front_url=COALESCE(NULLIF($6,''),cp_master.cp_aadhaar_front_url),
            cp_aadhaar_back_url=COALESCE(NULLIF($7,''),cp_master.cp_aadhaar_back_url),
            cp_pan_card_url=COALESCE(NULLIF($8,''),cp_master.cp_pan_card_url),
            cp_cancelled_cheque_url=COALESCE(NULLIF($9,''),cp_master.cp_cancelled_cheque_url),
            updated_at=NOW()`,
            [cpCode,d.cp_name,d.cp_phone,d.cp_firm||null,d.cp_email||null,
             d.cp_aadhaar_front_url||null,d.cp_aadhaar_back_url||null,d.cp_pan_card_url||null,d.cp_cancelled_cheque_url||null]);
        }
      }

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
      logger.logFormSubmit(d.uid,'cp_bill_submitted',8,req.user?.email,req.user?.name).catch(()=>{});
    }catch(e){console.error('CPBill:',e);res.status(500).json({error:e.message})}
  });
  router.post('/send-email/:uid',async(req,res)=>{
    try{
      const userId=req.user?.id;
      if(!userId)return res.status(401).json({error:'Not authenticated'});
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