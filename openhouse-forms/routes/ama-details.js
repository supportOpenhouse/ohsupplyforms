const express=require('express'),router=express.Router();
const logger=require('../utils/logger');
const{visibilityFilter}=require('../utils/visibility');
const{notifyAMASubmitted}=require('../utils/whatsapp');

module.exports=function(pool){
  router.get('/prefill/:uid',async(req,res)=>{
    try{const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      const p=rows[0];if(!p.token_deal_submitted_at)return res.status(400).json({error:'Deal Terms (Form 4) must be submitted first'});
      res.json(p)}catch(e){res.status(500).json({error:e.message})}
  });
  router.get('/uids',async(req,res)=>{
    try{const vis=visibilityFilter(req.user);const{rows}=await pool.query(`SELECT uid,city,society_name,unit_no,tower_no,owner_broker_name,token_deal_submitted_at,ama_submitted_at
      FROM properties WHERE token_deal_submitted_at IS NOT NULL AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE${vis.clause} ORDER BY updated_at DESC`,vis.params);res.json(rows)}catch(e){res.status(500).json({error:e.message})}
  });
  router.post('/submit',async(req,res)=>{
    try{
      const d=req.body;const{rows}=await pool.query('SELECT uid FROM properties WHERE uid=$1',[d.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      await pool.query(`UPDATE properties SET
        ama_prop_docs=$1,
        docs_verification_mode=$2,
        loan_applicant_name=$4,
        loan_co_applicant_name=$5,
        bank_name_loan=$6,
        loan_account_number=$7,
        outstanding_loan=$8,
        loan_pay_willingness=$9,
        ama_sanction_url=$10,
        ama_soa_url=$11,
        ama_lod_url=$12,
        ama_submitted_at=NOW(),updated_at=NOW()
        WHERE uid=$3`,
        [d.ama_prop_docs||'{}',
         d.docs_verification_mode||null,
         d.uid,
         d.loan_applicant_name||null,
         d.loan_co_applicant_name||null,
         d.bank_name_loan||null,
         d.loan_account_number||null,
         d.outstanding_loan!=null&&d.outstanding_loan!==''?parseFloat(d.outstanding_loan):null,
         d.loan_pay_willingness||null,
         d.ama_sanction_url||null,
         d.ama_soa_url||null,
         d.ama_lod_url||null]);
      res.json({success:true,uid:d.uid});
      logger.logFormSubmit(d.uid,'ama_details_submitted',5,req.user?.email,req.user?.name).catch(()=>{});
      pool.query('SELECT * FROM properties WHERE uid=$1',[d.uid]).then(({rows})=>{
        if(rows[0])notifyAMASubmitted(rows[0],null,{email:req.user?.email,name:req.user?.name}).catch(e=>console.error('WA AMA notify error:',e));
      }).catch(e=>console.error('WA AMA fetch error:',e));
    }catch(e){console.error('AMA:',e);res.status(500).json({error:e.message})}
  });

  return router;
};