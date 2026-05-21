const express=require('express'),router=express.Router();
const logger=require('../utils/logger');
const{visibilityFilter}=require('../utils/visibility');
const{sendPendingAmountEmail}=require('../utils/email-sender');
const{notifyAMASigned}=require('../utils/whatsapp');

module.exports=function(pool){
  router.get('/prefill/:uid',async(req,res)=>{
    try{const{rows}=await pool.query(`SELECT p.*,
        (SELECT email FROM users WHERE LOWER(name)=LOWER(p.assigned_by) AND is_active=TRUE LIMIT 1) AS assigned_by_email,
        (SELECT email FROM users WHERE LOWER(name)=LOWER(p.token_requested_by) AND is_active=TRUE LIMIT 1) AS token_requested_by_email
      FROM properties p WHERE p.uid=$1`,[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      const p=rows[0];if(!p.ama_submitted_at)return res.status(400).json({error:'AMA (Form 5) must be submitted first'});
      res.json(p)}catch(e){res.status(500).json({error:e.message})}
  });

  router.get('/uids',async(req,res)=>{
    try{const vis=visibilityFilter(req.user);const{rows}=await pool.query(`SELECT uid,city,society_name,unit_no,tower_no,owner_broker_name,ama_submitted_at,pending_request_submitted_at
      FROM properties WHERE ama_submitted_at IS NOT NULL AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE${vis.clause} ORDER BY updated_at DESC`,vis.params);res.json(rows)}catch(e){res.status(500).json({error:e.message})}
  });

  router.post('/submit',async(req,res)=>{
    try{
      const d=req.body;const{rows}=await pool.query('SELECT uid FROM properties WHERE uid=$1',[d.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      await pool.query(`UPDATE properties SET ama_date=$1,signed_ama_url=COALESCE($3,signed_ama_url),
        co_owner_aadhaar_front_url=COALESCE($4,co_owner_aadhaar_front_url),co_owner_aadhaar_back_url=COALESCE($5,co_owner_aadhaar_back_url),
        co_owner_pan_url=COALESCE($6,co_owner_pan_url),co_owner_cheque_url=COALESCE($7,co_owner_cheque_url),
        pending_request_submitted_at=NOW(),updated_at=NOW() WHERE uid=$2`,
        [d.ama_date||null,d.uid,d.signed_ama_url||null,
         d.co_owner_aadhaar_front_url||null,d.co_owner_aadhaar_back_url||null,
         d.co_owner_pan_url||null,d.co_owner_cheque_url||null]);
      res.json({success:true,uid:d.uid});
      logger.logFormSubmit(d.uid,'pending_request_submitted',6,req.user?.email,req.user?.name).catch(()=>{});
    }catch(e){console.error('PendingRequest:',e);res.status(500).json({error:e.message})}
  });

  router.post('/send-email/:uid',async(req,res)=>{
    try{
      const userId=req.user?.id;
      if(!userId)return res.status(401).json({error:'Not authenticated'});
      const{rows:uRows}=await pool.query('SELECT email,name,is_admin,is_manager,google_access_token,google_refresh_token FROM users WHERE id=$1',[userId]);
      if(!uRows.length)return res.status(401).json({error:'User not found'});
      const user=uRows[0];
      if(!user.google_access_token&&!user.google_refresh_token){
        return res.status(400).json({error:'Gmail not authorized. Please log out and log in again.'});
      }
      const{rows:pRows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!pRows.length)return res.status(404).json({error:'Property not found'});
      if(!pRows[0].pending_request_submitted_at)return res.status(400).json({error:'Form must be submitted first'});
      const result=await sendPendingAmountEmail({
        accessToken:user.google_access_token,refreshToken:user.google_refresh_token,
        fromEmail:user.email,senderName:user.name||user.email,property:pRows[0],
        owner1_name:req.body.owner1_name,owner1_amount:req.body.owner1_amount,
        owner2_name:req.body.owner2_name,owner2_amount:req.body.owner2_amount,
        threadId:pRows[0].email_thread_id||null,references:pRows[0].email_message_id||null
      });
      if(!pRows[0].email_thread_id&&result.threadId){
        await pool.query('UPDATE properties SET email_thread_id=$1,email_message_id=COALESCE($3,email_message_id) WHERE uid=$2',[result.threadId,req.params.uid,result.rfc822MsgId||null]);
      }
      console.log(`Pending amount email sent for ${req.params.uid} by ${user.email} — msgId: ${result.messageId}`);
      notifyAMASigned(pRows[0],user.name||user.email,{email:user.email,name:user.name}).catch(e=>console.error('WA ama_signed error:', e));
      res.json({success:true,messageId:result.messageId});
    }catch(e){
      console.error('PendingAmountEmail:',e);
      if(e.message?.includes('invalid_grant')||e.message?.includes('Token has been expired')||e.code===401){
        return res.status(401).json({error:'Gmail token expired. Please log out and log in again.'});
      }
      res.status(500).json({error:e.message||'Failed to send email'});
    }
  });

  return router;
};