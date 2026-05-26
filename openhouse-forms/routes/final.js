const express=require('express'),router=express.Router();
const logger=require('../utils/logger');
const{generateInvoiceHTML}=require('../utils/invoice-template');
const{sendKeyHandoverEmail}=require('../utils/email-sender');
const{notifyKeyHandover}=require('../utils/whatsapp');
const{visibilityFilter}=require('../utils/visibility');
module.exports=function(pool){
  router.get('/prefill/:uid',async(req,res)=>{
    try{const{rows}=await pool.query(`SELECT p.*,
        (SELECT email FROM users WHERE LOWER(name)=LOWER(p.assigned_by) AND is_active=TRUE LIMIT 1) AS assigned_by_email,
        (SELECT email FROM users WHERE LOWER(name)=LOWER(p.token_requested_by) AND is_active=TRUE LIMIT 1) AS token_requested_by_email
      FROM properties p WHERE p.uid=$1`,[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      const p=rows[0];if(!p.pending_request_submitted_at)return res.status(400).json({error:'Pending Amount Request (Form 6) must be submitted first'});
      res.json(p)}catch(e){res.status(500).json({error:e.message})}
  });
  router.get('/uids',async(req,res)=>{
    try{const vis=visibilityFilter(req.user);const{rows}=await pool.query(`SELECT uid,city,society_name,unit_no,tower_no,owner_broker_name,pending_request_submitted_at,final_submitted_at
      FROM properties WHERE pending_request_submitted_at IS NOT NULL AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE${vis.clause} ORDER BY updated_at DESC`,vis.params);res.json(rows)}catch(e){res.status(500).json({error:e.message})}
  });
  router.post('/submit',async(req,res)=>{
    try{
      const d=req.body;const{rows}=await pool.query('SELECT uid FROM properties WHERE uid=$1',[d.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      if(!d.key_handover_date)return res.status(400).json({error:'Key Handover Date required'});
      await pool.query(`UPDATE properties SET
        remaining_amount=$1,key_handover_date=$3,
        final_submitted_at=NOW(),updated_at=NOW()
        WHERE uid=$2`,
        [parseFloat(d.remaining_amount)||null,d.uid,d.key_handover_date||null]);
      res.json({success:true,uid:d.uid});
      logger.logFormSubmit(d.uid,'key_handover_submitted',9,req.user?.email,req.user?.name).catch(()=>{});
    }catch(e){console.error('Final:',e);res.status(500).json({error:e.message})}
  });
  router.get('/pdf/:uid',async(req,res)=>{
    try{const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'Not found'});
      if(!rows[0].final_submitted_at)return res.status(400).json({error:'Submit form first'});
      const html=generateInvoiceHTML(rows[0]);
      res.setHeader('Content-Type','text/html');res.send(html);
    }catch(e){console.error('PDF:',e);res.status(500).json({error:'PDF failed'})}
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
      if(!p.final_submitted_at)return res.status(400).json({error:'Form must be submitted first'});
      if(p.final_email_sent===true)return res.status(409).json({error:'Email Sent Already',alreadySent:true});
      if(!p.owner_email)return res.status(400).json({error:'Owner email not found. Set it in Deal Terms form.'});
      const senderName=user.name||user.email.split('@')[0];
      const result=await sendKeyHandoverEmail({
        accessToken:user.google_access_token,refreshToken:user.google_refresh_token,
        fromEmail:user.email,senderName,property:p,threadId:p.email_thread_id||null,references:p.email_message_id||null
      });
      if(!p.email_thread_id&&result.threadId){
        await pool.query('UPDATE properties SET email_thread_id=$1,email_message_id=COALESCE($3,email_message_id) WHERE uid=$2',[result.threadId,req.params.uid,result.rfc822MsgId||null]);
      }
      await pool.query('UPDATE properties SET final_email_sent=TRUE,updated_at=NOW() WHERE uid=$1',[req.params.uid]);
      console.log(`Key handover email sent for ${req.params.uid} by ${user.email} — msgId: ${result.messageId}`);
      notifyKeyHandover(p,senderName,{email:user.email,name:user.name}).catch(e=>console.error('WA key_handover error:', e));
      res.json({success:true,messageId:result.messageId});
    }catch(e){
      console.error('KeyHandoverEmail:',e);
      if(e.message?.includes('invalid_grant')||e.message?.includes('Token has been expired')||e.code===401){
        return res.status(401).json({error:'Gmail token expired. Please log out and log in again.'});
      }
      res.status(500).json({error:e.message||'Failed to send email'});
    }
  });

  return router;
};