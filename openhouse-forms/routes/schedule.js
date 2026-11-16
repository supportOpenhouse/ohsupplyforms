const express=require('express'),router=express.Router();
const logger=require('../utils/logger');
const{notifyVisitScheduled}=require('../utils/whatsapp');
const{syncVisitCalendar}=require('../utils/calendar');
const{initHistory}=require('../utils/visit-history');
const{withSlot,slotErrorBody}=require('../utils/slot-guard');

const CITY_MAP={'Gurgaon':'G','Noida':'N','Ghaziabad':'GH'};
const SRC_MAP={'CP':'C','Direct':'D'};

module.exports=function(pool){

  // Generate next UID: OH{G/N/GH}{C/D}{001...}
  router.get('/next-uid',async(req,res)=>{
    try{
      const{city,source}=req.query;
      if(!city||!source)return res.status(400).json({error:'city and source required'});
      const ci=CITY_MAP[city];const si=SRC_MAP[source];
      if(!ci||!si)return res.status(400).json({error:'Invalid city or source'});
      const prefix=`OH${ci}${si}`;
      const{rows}=await pool.query(`SELECT MAX(CAST(REPLACE(uid,$1,'') AS INTEGER)) as max_num FROM properties WHERE uid LIKE $2`,[prefix, prefix+'%']);
      const next=(rows[0].max_num||1000)+1;
      const uid=prefix+String(next);
      res.json({uid,prefix,next});
    }catch(e){res.status(500).json({error:e.message})}
  });

  // Check existing properties in a society
  router.get('/society-check',async(req,res)=>{
    try{
      const society=req.query.society;
      if(!society)return res.json([]);
      const{rows}=await pool.query('SELECT uid,unit_no,tower_no,floor,area_sqft,configuration FROM properties WHERE society_name=$1 AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE AND replicated IS NOT TRUE ORDER BY created_at DESC',[society]);
      res.json(rows);
    }catch(e){res.status(500).json({error:e.message})}
  });

  // Get busy slots for a field exec on a given date
  router.get('/busy-slots',async(req,res)=>{
    try{
      const{field_exec,date}=req.query;
      if(!field_exec||!date)return res.json([]);
      const{rows}=await pool.query(
        `SELECT schedule_time,uid,society_name,unit_no,tower_no FROM properties
         WHERE field_exec=$1 AND schedule_date=$2 AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE AND replicated IS NOT TRUE
         ORDER BY schedule_time ASC`,[field_exec,date]);
      // Return busy hours (extract hour from each time)
      const slots=rows.map(r=>{
        const hr=r.schedule_time?parseInt(r.schedule_time.split(':')[0]):null;
        return{hour:hr,time:r.schedule_time,uid:r.uid,society:r.society_name,unit:r.unit_no,tower:r.tower_no};
      }).filter(s=>s.hour!==null);
      res.json(slots);
    }catch(e){res.status(500).json({error:e.message})}
  });

  router.post('/submit',async(req,res)=>{
    try{
      const d=req.body;if(!d.uid||!d.uid.trim())return res.status(400).json({error:'UID is required'});
      const uid=d.uid.trim().toUpperCase();
      const ex=await pool.query('SELECT uid FROM properties WHERE uid=$1',[uid]);
      if(ex.rows.length)return res.status(400).json({error:'UID already exists'});
      // Block submissions for societies marked inactive in master_societies
      if(d.society_name){
        const soc=await pool.query(`SELECT bool_and(active) AS active FROM master_societies
          WHERE LOWER(TRIM(society_name))=LOWER(TRIM($1)) AND ($2::text='' OR LOWER(TRIM(locality))=LOWER(TRIM($2)))`,
          [d.society_name,d.locality||'']);
        if(soc.rows[0]&&soc.rows[0].active===false)
          return res.status(403).json({error:`Submissions are blocked for ${d.society_name}${d.locality?', '+d.locality:''} — this society is inactive. Please contact admin.`});
      }
      // Reject past dates
      if(d.schedule_date){const today=new Date().toISOString().split('T')[0];
        if(d.schedule_date<today)return res.status(400).json({error:'Schedule date cannot be in the past'})}
      // Combine first+last into owner_broker_name for backward compat
      const ownerName=[d.first_name,d.last_name].filter(Boolean).join(' ');
      // No overlapping visits for the RM — checked and written atomically (utils/slot-guard).
      const slot=await withSlot(pool,{fieldExec:d.field_exec,date:d.schedule_date,time:d.schedule_time},q=>q.query(`INSERT INTO properties(uid,schedule_date,schedule_time,lead_id,source,first_name,last_name,owner_broker_name,contact_no,
        area_sqft,demand_price,city,society_name,locality,unit_no,tower_no,floor,configuration,assigned_by,field_exec,visit_date_history,schedule_submitted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())`,
        [uid,d.schedule_date||null,d.schedule_time||null,d.lead_id||null,d.source||null,
         d.first_name||null,d.last_name||null,ownerName||null,d.contact_no||null,
         parseFloat(d.area_sqft)||null,parseFloat(d.demand_price)||null,
         d.city||null,d.society_name||null,d.locality||null,d.unit_no||null,d.tower_no||null,
         d.floor||null,d.configuration||null,d.assigned_by||null,d.field_exec||null,
         JSON.stringify(initHistory(d.schedule_date||null))]));
      if(slot.error)return res.status(slot.error.status).json(slotErrorBody(slot.error));
      res.json({success:true,uid});
      logger.logFormSubmit(uid,'schedule_submitted',1,req.user?.email,req.user?.name).catch(()=>{});
      // Fire-and-forget WhatsApp notification to assigned_to
      notifyVisitScheduled({uid,...d,owner_broker_name:ownerName},{email:req.user?.email,name:req.user?.name}).catch(e=>console.error('WA schedule notify error:',e));
      // Fire-and-forget Google Calendar event for assigned_by + assigned_to
      syncVisitCalendar(pool,{uid,action:'create',actorUserId:req.user?.id}).catch(e=>console.error('Cal schedule sync error:',e));
    }catch(e){console.error('Schedule:',e);res.status(500).json({error:e.message})}
  });

  router.get('/uids',async(_,res)=>{
    try{const{rows}=await pool.query(`SELECT uid,city,society_name,unit_no,tower_no,owner_broker_name FROM properties WHERE schedule_submitted_at IS NOT NULL AND replicated IS NOT TRUE ORDER BY created_at DESC`);res.json(rows)}catch(e){res.status(500).json({error:e.message})}
  });

  return router;
};