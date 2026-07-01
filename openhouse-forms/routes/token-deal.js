const express=require('express'),router=express.Router();
const logger=require('../utils/logger');
const{generateReceiptHTML}=require('../utils/pdf-template');
const{sendDealTermsEmail}=require('../utils/email-sender');
const{visibilityFilter}=require('../utils/visibility');
const{getPhone,notifyDealTermsShared}=require('../utils/whatsapp');

/** Fields forwarded to Core for Home + Seller creation (explicit allow-list). */
function buildCorePayload(row){
  return{
    supply_form_uid:row.uid,
    uid:row.uid,
    city:row.city,
    locality:row.locality,
    society_name:row.society_name,
    tower_no:row.tower_no,
    unit_no:row.unit_no,
    floor:row.floor,
    configuration:row.configuration,
    area_sqft:row.area_sqft,
    bathrooms:row.bathrooms,
    society_age_years:row.society_age_years,
    owner_broker_name:row.owner_broker_name,
    first_name:row.first_name,
    last_name:row.last_name,
    contact_no:row.contact_no,
    listing_asking_price:row.listing_asking_price,
    demand_price:0,
    token_requested_by:row.token_requested_by,
  };
}

module.exports=function(pool){
  router.get('/prefill/:uid',async(req,res)=>{
    try{const{rows}=await pool.query(`SELECT p.*,
        (SELECT email FROM users WHERE LOWER(name)=LOWER(p.assigned_by) AND is_active=TRUE LIMIT 1) AS assigned_by_email,
        (SELECT email FROM users WHERE LOWER(name)=LOWER(p.token_requested_by) AND is_active=TRUE LIMIT 1) AS token_requested_by_email
      FROM properties p WHERE p.uid=$1`,[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      const p=rows[0];if(!p.token_submitted_at&&!p.token_is_draft)return res.status(400).json({error:'Token Request must be submitted first'});
      res.json(p)}catch(e){res.status(500).json({error:e.message})}
  });
  router.get('/uids',async(req,res)=>{
    try{const vis=visibilityFilter(req.user);const{rows}=await pool.query(`SELECT uid,city,society_name,unit_no,tower_no,owner_broker_name,token_submitted_at,token_is_draft,token_deal_submitted_at
      FROM properties WHERE (token_submitted_at IS NOT NULL OR token_is_draft=TRUE) AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE AND replicated IS NOT TRUE${vis.clause} ORDER BY updated_at DESC`,vis.params);res.json(rows)}catch(e){res.status(500).json({error:e.message})}
  });
  router.post('/submit',async(req,res)=>{
    try{
      const d=req.body;const{rows}=await pool.query('SELECT uid FROM properties WHERE uid=$1',[d.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      if(d.deal_token_amount==null||d.deal_token_amount==='')return res.status(400).json({error:'Token amount required'});
      await pool.query(`UPDATE properties SET deal_token_amount=$1,
        deal_bank_name=$2,deal_bank_account_number=$3,deal_ifsc_code=$4,deal_transfer_date=$5,deal_neft_reference=$6,
        owner_email=$8,co_owner_email=$9,third_owner_email=$10,broker_email=$11,token_remarks_printed=$12,
        token_is_draft=FALSE,token_deal_submitted_at=NOW(),updated_at=NOW() WHERE uid=$7`,
        [d.deal_token_amount!=null&&d.deal_token_amount!==''?parseFloat(d.deal_token_amount):null,
         d.deal_bank_name||null,d.deal_bank_account_number||null,d.deal_ifsc_code||null,d.deal_transfer_date||null,(d.deal_neft_reference||'').toUpperCase()||null,
         d.uid,d.owner_email||null,d.co_owner_email||null,d.third_owner_email||null,d.broker_email||null,(d.token_remarks_printed||'').trim()||null]);
      res.json({success:true,uid:d.uid});
      logger.logFormSubmit(d.uid,'deal_terms_submitted',4,req.user?.email,req.user?.name).catch(()=>{});
    }catch(e){console.error('TokenDeal:',e);res.status(500).json({error:e.message})}
  });
  router.get('/pdf/:uid',async(req,res)=>{
    try{const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'Not found'});
      if(!rows[0].token_deal_submitted_at)return res.status(400).json({error:'Submit deal terms first'});
      const html=generateReceiptHTML(rows[0],'deal');
      res.setHeader('Content-Type','text/html');res.send(html);
    }catch(e){console.error('DealPDF:',e);res.status(500).json({error:'Failed'})}
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
      if(!pRows[0].token_deal_submitted_at)return res.status(400).json({error:'Deal terms must be submitted first'});
      const p=pRows[0];
      if(p.token_deal_email_sent===true&&!(req.body&&req.body.force))return res.status(409).json({error:'Email Sent Already',alreadySent:true});
      if(!p.core_home_id)return res.status(400).json({error:'Seller Dashboard Not Created Yet',noDashboard:true});
      if(!p.owner_email)return res.status(400).json({error:'Owner email is required to send'});
      const baseUrl=process.env.APP_URL||'';
      const pdfHtml=generateReceiptHTML(p,'deal',baseUrl);
      const signatoryName=user.name||user.email.split('@')[0];
      const signatoryPhone=await getPhone(signatoryName)||'';
      const result=await sendDealTermsEmail({
        accessToken:user.google_access_token,refreshToken:user.google_refresh_token,
        fromEmail:user.email,property:p,pdfHtml,signatoryName,signatoryPhone
      });
      // Deal Terms is the thread anchor — always save threadId + messageId
      if(result.threadId){
        await pool.query('UPDATE properties SET email_thread_id=$1,email_message_id=$3 WHERE uid=$2',[result.threadId,req.params.uid,result.rfc822MsgId||null]);
      }
      await pool.query('UPDATE properties SET token_deal_email_sent=TRUE,updated_at=NOW() WHERE uid=$1',[req.params.uid]);
      console.log(`Deal email sent for ${req.params.uid} by ${user.email} — msgId: ${result.messageId}`);
      notifyDealTermsShared(p,signatoryName,{email:user.email,name:user.name}).catch(e=>console.error('WA deal_terms error:', e));
      res.json({success:true,messageId:result.messageId});
    }catch(e){
      console.error('DealEmail:',e);
      if(e.message?.includes('invalid_grant')||e.message?.includes('Token has been expired')||e.code===401){
        return res.status(401).json({error:'Gmail token expired. Please log out and log in again.'});
      }
      res.status(500).json({error:e.message||'Failed to send email'});
    }
  });
  router.post('/create-seller-dashboard',async(req,res)=>{
    const tag='[token-deal/create-seller-dashboard]';
    try{
      const uid=(req.body&&req.body.uid)?String(req.body.uid).trim():'';
      if(!uid){
        console.warn(tag,'reject: missing uid');
        return res.status(400).json({error:'uid is required'});
      }
      console.log(tag,'start',{uid,userEmail:req.user&&req.user.email});

      const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[uid]);
      if(!rows.length){
        console.warn(tag,'reject: uid not found',{uid});
        return res.status(404).json({error:'UID not found'});
      }
      const p=rows[0];
      if(!p.token_deal_submitted_at){
        console.warn(tag,'reject: token deal not submitted',{uid});
        return res.status(400).json({error:'Deal Terms must be submitted first'});
      }
      if(p.core_home_id){
        console.log(tag,'idempotent: core_home_id already set',{uid,core_home_id:p.core_home_id});
        return res.status(200).json({
          message:'Seller dashboard already linked',
          idempotent:true,
          home_id:p.core_home_id,
          uid,
        });
      }

      const coreBase=(process.env.CORE_API_BASE_URL||'').replace(/\/$/,'');
      const apiKey=(process.env.SUPPLY_FORM_API_KEY||'').trim();
      if(!coreBase||!apiKey){
        console.error(tag,'misconfigured: CORE_API_BASE_URL or SUPPLY_FORM_API_KEY missing');
        return res.status(503).json({error:'Core integration not configured on this server'});
      }

      const payload=buildCorePayload(p);
      console.log(tag,'initial_payload_to_core',JSON.stringify(payload));

      const url=`${coreBase}/api/v1/oh/supply-form/create-home/`;
      const r=await fetch(url,{
        method:'POST',
        headers:{'Content-Type':'application/json','X-Supply-Form-Key':apiKey},
        body:JSON.stringify(payload),
      });
      let j={};
      try{j=await r.json();}catch(_){}
      console.log(tag,'core_response',{status:r.status,bodyPreview:JSON.stringify(j).slice(0,4000)});

      const homeId=j.home_id??j.homeId??(j.home&&(j.home.id??j.homeId));
      if(r.ok&&homeId!=null){
        await pool.query('UPDATE properties SET core_home_id=$1,updated_at=NOW() WHERE uid=$2',[homeId,uid]);
        console.log(tag,'stored core_home_id',{uid,homeId});
      }else if(r.status===200&&(j.idempotent||j.idempotent===true)&&homeId!=null){
        await pool.query('UPDATE properties SET core_home_id=$1,updated_at=NOW() WHERE uid=$2',[homeId,uid]);
      }

      if(!r.ok){
        return res.status(r.status).json({
          error:j.error||j.message||'Core request failed',
          details:j.details||j,
          trace:j.trace,
        });
      }
      return res.status(r.status).json({...j,uid});
    }catch(e){
      console.error(tag,'exception',e);
      return res.status(500).json({error:e.message});
    }
  });
  router.post('/token-refunded/:uid',async(req,res)=>{
    try{
      const{rows}=await pool.query('SELECT uid,is_token_refunded FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      const newVal=!rows[0].is_token_refunded;
      await pool.query('UPDATE properties SET is_token_refunded=$1,updated_at=NOW() WHERE uid=$2',[newVal,req.params.uid]);
      res.json({success:true,is_token_refunded:newVal});
      logger.logStatusChange(req.params.uid,newVal?'cancelled_post_token':'undo_cancelled_post_token',!newVal,newVal,req.user?.email,req.user?.name).catch(()=>{});
    }catch(e){res.status(500).json({error:e.message})}
  });
  return router;
};