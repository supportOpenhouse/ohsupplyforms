const express=require('express'),router=express.Router();
const logger=require('../utils/logger');
const{generateReceiptHTML}=require('../utils/pdf-template');
const{sendTokenRequestEmail}=require('../utils/email-sender');
const{visibilityFilter}=require('../utils/visibility');
const{notifyTokenRequest}=require('../utils/whatsapp');

module.exports=function(pool){
  router.get('/prefill/:uid',async(req,res)=>{
    try{const{rows}=await pool.query(`SELECT p.*,
        (SELECT email FROM users WHERE LOWER(name)=LOWER(p.assigned_by) AND is_active=TRUE LIMIT 1) AS assigned_by_email,
        (SELECT email FROM users WHERE LOWER(name)=LOWER(p.token_requested_by) AND is_active=TRUE LIMIT 1) AS token_requested_by_email
      FROM properties p WHERE p.uid=$1`,[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});res.json(rows[0])}catch(e){res.status(500).json({error:e.message})}
  });
  router.get('/uids',async(req,res)=>{
    try{const vis=visibilityFilter(req.user);const{rows}=await pool.query(`SELECT uid,city,society_name,unit_no,tower_no,owner_broker_name,contact_no FROM properties WHERE visit_submitted_at IS NOT NULL AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE AND replicated IS NOT TRUE${vis.clause} ORDER BY created_at DESC`,vis.params);res.json(rows)}catch(e){res.status(500).json({error:e.message})}
  });
  router.post('/submit',async(req,res)=>{
    try{
      const d=req.body;const isDraft=d.is_draft===true||d.is_draft==='true';
      const{rows}=await pool.query('SELECT uid FROM properties WHERE uid=$1',[d.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      await pool.query(`UPDATE properties SET
        unit_no=$22,tower_no=$23,floor=$24,area_sqft=$25,demand_price=$26,
        token_requested_by=$1,deal_token_amount=$2,
        cheque_image_url=$3,cheque_bank_name=$4,cheque_account_number=$5,cheque_ifsc=$6,
        registry_status=$7,occupancy_status=$8,key_handover_date=$9,
        guaranteed_sale_price=$10,performance_guarantee=$11,
        initial_period=$12,rent_payable_initial_period=$13,
        grace_period=$14,rent_payable_grace_period=$15,
        documents_available=$16,token_remarks=$17,token_is_draft=$18,
        has_loan=$41,
        token_remarks_printed=COALESCE($20,token_remarks_printed),co_owner=$21,co_owner_number=$27,
        owner_pan_url=$28,owner_aadhaar_front_url=$29,owner_aadhaar_back_url=$30,owner_property_doc_url=$31,
        total_deposit=$32,refundable_deposit=$33,
        ama_pg_non_forfeitable=$34,ama_beta_max_pct=$35,ama_beta_min_pct=$36,
        ama_maint_alignment=$37,ama_elec_alignment=$38,ama_special_terms=$39,
        ama_payment_structure=$40,
        token_submitted_at=CASE WHEN $18=FALSE THEN NOW() ELSE token_submitted_at END,updated_at=NOW()
        WHERE uid=$19`,
        [d.token_requested_by||null,d.deal_token_amount!=null&&d.deal_token_amount!==''?parseFloat(d.deal_token_amount):null,
         d.cheque_image_url||null,d.cheque_bank_name||null,d.cheque_account_number||null,d.cheque_ifsc||null,
         d.registry_status||null,d.occupancy_status||null,d.key_handover_date||null,
         parseFloat(d.guaranteed_sale_price)||null,d.performance_guarantee!=null&&d.performance_guarantee!==''?parseFloat(d.performance_guarantee):null,
         parseInt(d.initial_period)||null,d.rent_payable_initial_period||null,
         parseInt(d.grace_period)||null,d.rent_payable_grace_period||null,
         d.documents_available||'[]',d.token_remarks||null,isDraft,d.uid,
         d.token_remarks_printed||null,d.co_owner||null,
         d.unit_no||null,d.tower_no||null,parseInt(d.floor)||null,parseFloat(d.area_sqft)||null,parseFloat(d.demand_price)||null,
         d.co_owner_number||null,
         d.owner_pan_url||null,d.owner_aadhaar_front_url||null,d.owner_aadhaar_back_url||null,d.owner_property_doc_url||null,
         d.total_deposit!=null&&d.total_deposit!==''?parseFloat(d.total_deposit):null,d.refundable_deposit!=null&&d.refundable_deposit!==''?parseFloat(d.refundable_deposit):null,
         d.ama_pg_non_forfeitable||null,d.ama_beta_max_pct!=null&&d.ama_beta_max_pct!==''?parseFloat(d.ama_beta_max_pct):null,d.ama_beta_min_pct!=null&&d.ama_beta_min_pct!==''?parseFloat(d.ama_beta_min_pct):null,
         d.ama_maint_alignment||null,d.ama_elec_alignment||null,d.ama_special_terms||null,
         d.ama_payment_structure||null,
         d.has_loan||null]);
      res.json({success:true,uid:d.uid,draft:isDraft});
      logger.logFormSubmit(d.uid,'token_request_submitted',3,req.user?.email,req.user?.name,isDraft).catch(()=>{});
    }catch(e){console.error('TokenReq:',e);res.status(500).json({error:e.message})}
  });
  // Update owner name (CP → Owner correction)
  router.post('/update-owner/:uid',async(req,res)=>{
    try{
      const{first_name,last_name,owner_broker_name,contact_no,cp_name,cp_phone}=req.body;
      if(!owner_broker_name)return res.status(400).json({error:'Name required'});
      const{rows:old}=await pool.query('SELECT owner_broker_name,contact_no,cp_name,cp_phone FROM properties WHERE uid=$1',[req.params.uid]);
      await pool.query('UPDATE properties SET first_name=$1,last_name=$2,owner_broker_name=$3,contact_no=COALESCE($4,contact_no),cp_name=COALESCE($5,cp_name),cp_phone=COALESCE($6,cp_phone),updated_at=NOW() WHERE uid=$7',
        [first_name||null,last_name||null,owner_broker_name,contact_no||null,cp_name||null,cp_phone||null,req.params.uid]);
      res.json({success:true});
      if(old.length){
        const changes={};
        if(old[0].owner_broker_name!==owner_broker_name)changes.owner_broker_name={old:old[0].owner_broker_name,new:owner_broker_name};
        if(contact_no&&old[0].contact_no!==contact_no)changes.contact_no={old:old[0].contact_no,new:contact_no};
        if(cp_name&&old[0].cp_name!==cp_name)changes.cp_name={old:old[0].cp_name,new:cp_name};
        if(Object.keys(changes).length)logger.log(req.params.uid,'broker/cp change','pre-email change',req.user?.email,req.user?.name,{changes}).catch(()=>{});
      }
    }catch(e){console.error('UpdateOwner:',e);res.status(500).json({error:e.message})}
  });

  router.get('/pdf/:uid',async(req,res)=>{
    try{const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'Not found'});
      const html=generateReceiptHTML(rows[0],'deal');
      res.setHeader('Content-Type','text/html');
      res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
      res.setHeader('Pragma','no-cache');
      res.send(html);
    }catch(e){console.error('TokenReqPDF:',e);res.status(500).json({error:'PDF failed'})}
  });
  router.post('/send-email/:uid',async(req,res)=>{
    try{
      const userId=req.user?.id;
      if(!userId)return res.status(401).json({error:'Not authenticated'});
      const{rows:uRows}=await pool.query('SELECT email,google_access_token,google_refresh_token FROM users WHERE id=$1',[userId]);
      if(!uRows.length)return res.status(401).json({error:'User not found'});
      const user=uRows[0];
      if(!user.google_access_token&&!user.google_refresh_token){
        return res.status(400).json({error:'Gmail not authorized. Please log out and log in again to grant email permission.'});
      }
      const{rows:pRows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!pRows.length)return res.status(404).json({error:'Property not found'});
      const p=pRows[0];
      if(!p.token_submitted_at)return res.status(400).json({error:'Token request must be submitted first'});
      if(p.token_request_email_sent===true&&!(req.body&&req.body.force))return res.status(409).json({error:'Email Sent Already',alreadySent:true});
      const baseUrl=process.env.APP_URL||'';
      const pdfHtml=generateReceiptHTML(p,'deal',baseUrl);
      const result=await sendTokenRequestEmail({
        accessToken:user.google_access_token,refreshToken:user.google_refresh_token,
        fromEmail:user.email,property:p,pdfHtml
      });
      await pool.query('UPDATE properties SET token_request_email_sent=TRUE,updated_at=NOW() WHERE uid=$1',[req.params.uid]);
      console.log(`Email sent for ${req.params.uid} by ${user.email} — msgId: ${result.messageId}`);
      res.json({success:true,messageId:result.messageId});
      notifyTokenRequest(p,{email:req.user?.email,name:req.user?.name}).catch(e=>console.error('WA token notify error:',e));
    }catch(e){
      console.error('SendEmail:',e);
      if(e.message?.includes('invalid_grant')||e.message?.includes('Token has been expired')||e.code===401){
        return res.status(401).json({error:'Gmail token expired. Please log out and log in again.'});
      }
      res.status(500).json({error:e.message||'Failed to send email'});
    }
  });
  return router;
};