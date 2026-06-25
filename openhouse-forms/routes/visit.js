const express=require('express'),router=express.Router();
const logger=require('../utils/logger');
const{visibilityFilter}=require('../utils/visibility');
const{notifyVisitCompleted,notifyVisitReassigned,notifyVisitCancelled,notifyVisitScheduled}=require('../utils/whatsapp');
const{syncVisitCalendar}=require('../utils/calendar');
const{addReschedule,setCancelled,dateStr}=require('../utils/visit-history');
module.exports=function(pool){
  router.get('/prefill/:uid',async(req,res)=>{
    try{const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});res.json(rows[0])}catch(e){res.status(500).json({error:e.message})}
  });
  router.get('/uids',async(req,res)=>{
    try{const vis=visibilityFilter(req.user);const{rows}=await pool.query(`SELECT uid,city,society_name,unit_no,tower_no,owner_broker_name FROM properties WHERE schedule_submitted_at IS NOT NULL AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE AND replicated IS NOT TRUE${vis.clause} ORDER BY created_at DESC`,vis.params);res.json(rows)}catch(e){res.status(500).json({error:e.message})}
  });
  router.post('/submit',async(req,res)=>{
    try{
      const d=req.body;if(!d.uid)return res.status(400).json({error:'UID required'});
      await pool.query(`UPDATE properties SET
        source=$1,demand_price=$2,owner_broker_name=$3,first_name=$4,last_name=$5,contact_no=$6,
        city=$7,locality=$8,society_name=$9,unit_no=$10,tower_no=$11,floor=$12,configuration=$13,area_sqft=$14,
        extra_area=$15,bathrooms=$16,balconies=$17,
        gas_pipeline=$18,parking=$19,furnishing=$20,furnishing_details=$21,
        total_lifts=$22,total_floors_tower=$23,total_flats_floor=$24,
        exit_facing=$25,exit_compass_image=$26,video_link=$27,
        balcony_details=$28,additional_images=$29,visit_remarks=$30,
        visit_submitted_at=NOW(),updated_at=NOW()
        WHERE uid=$31`,
        [d.source,parseFloat(d.demand_price)||null,d.owner_broker_name,d.first_name||null,d.last_name||null,d.contact_no,
         d.city,d.locality,d.society_name,d.unit_no,d.tower_no||null,parseInt(d.floor)??null,d.configuration,parseFloat(d.area_sqft)||null,
         d.extra_area||'[]',parseInt(d.bathrooms)??null,parseInt(d.balconies)??null,
         d.gas_pipeline||null,d.parking,d.furnishing||null,d.furnishing_details||'[]',
         parseInt(d.total_lifts)??null,parseInt(d.total_floors_tower)??null,parseInt(d.total_flats_floor)??null,
         d.exit_facing||null,d.exit_compass_image||null,d.video_link||null,
         d.balcony_details||'[]',d.additional_images||'[]',d.visit_remarks||null,d.uid]);
      res.json({success:true,uid:d.uid});
      logger.logFormSubmit(d.uid,'visit_submitted',2,req.user?.email,req.user?.name).catch(()=>{});
      pool.query('SELECT * FROM properties WHERE uid=$1',[d.uid]).then(({rows})=>{
        if(rows[0])notifyVisitCompleted(rows[0],{email:req.user?.email,name:req.user?.name}).catch(e=>console.error('WA visit notify error:',e));
      }).catch(e=>console.error('WA visit fetch error:',e));
      // Mark the calendar event done
      syncVisitCalendar(pool,{uid:d.uid,action:'done',actorUserId:req.user?.id}).catch(e=>console.error('Cal done sync error:',e));
    }catch(e){console.error('Visit:',e);res.status(500).json({error:e.message})}
  });
  // Mark UID as dead
  router.post('/dead/:uid',async(req,res)=>{
    try{
      const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      await pool.query('UPDATE properties SET is_dead=TRUE,visit_date_history=$2,updated_at=NOW() WHERE uid=$1',
        [req.params.uid,JSON.stringify(setCancelled(rows[0].visit_date_history,rows[0].schedule_date))]);
      res.json({success:true,uid:req.params.uid});
      logger.logStatusChange(req.params.uid,'visit_cancelled',false,true,req.user?.email,req.user?.name).catch(()=>{});
      // Notify assigned_by that visit is cancelled
      const cancelledBy=req.user?.name||req.user?.email||'Unknown';
      notifyVisitCancelled(rows[0],cancelledBy,{email:req.user?.email,name:req.user?.name}).catch(e=>console.error('WA cancel notify error:',e));
      // Remove the calendar event
      syncVisitCalendar(pool,{uid:req.params.uid,action:'delete',actorUserId:req.user?.id}).catch(e=>console.error('Cal cancel sync error:',e));
    }catch(e){console.error('Dead:',e);res.status(500).json({error:e.message})}
  });
  // Re-assign field_exec
  router.post('/reassign/:uid',async(req,res)=>{
    try{
      const{field_exec}=req.body;
      if(!field_exec)return res.status(400).json({error:'Select a person'});
      const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      await pool.query('UPDATE properties SET field_exec=$1,updated_at=NOW() WHERE uid=$2',[field_exec,req.params.uid]);
      res.json({success:true,uid:req.params.uid,field_exec});
      logger.logScheduleChange(req.params.uid,'visit_reassigned',{old_exec:rows[0].field_exec,new_exec:field_exec},req.user?.email,req.user?.name).catch(()=>{});
      // Notify new assignee
      notifyVisitReassigned(rows[0],field_exec,{email:req.user?.email,name:req.user?.name}).catch(e=>console.error('WA reassign notify error:',e));
      // Update calendar event attendees
      syncVisitCalendar(pool,{uid:req.params.uid,action:'update',actorUserId:req.user?.id}).catch(e=>console.error('Cal reassign sync error:',e));
    }catch(e){console.error('Reassign:',e);res.status(500).json({error:e.message})}
  });
  // Reschedule visit date/time
  router.post('/reschedule/:uid',async(req,res)=>{
    try{
      const{schedule_date,schedule_time}=req.body;
      if(!schedule_date)return res.status(400).json({error:'Date is required'});
      if(!schedule_time)return res.status(400).json({error:'Time is required'});
      const today=new Date().toISOString().split('T')[0];
      if(schedule_date<today)return res.status(400).json({error:'Cannot schedule in the past'});
      const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      if(rows[0].visit_submitted_at)return res.status(400).json({error:'Visit already completed, cannot reschedule'});
      // Record the old date in the history when the date actually changes
      const dateChanged=dateStr(rows[0].schedule_date)!==dateStr(schedule_date);
      const newHist=dateChanged?JSON.stringify(addReschedule(rows[0].visit_date_history,rows[0].schedule_date,schedule_date)):null;
      await pool.query('UPDATE properties SET schedule_date=$1,schedule_time=$2,visit_date_history=COALESCE($4,visit_date_history),updated_at=NOW() WHERE uid=$3',[schedule_date,schedule_time,req.params.uid,newHist]);
      res.json({success:true,uid:req.params.uid,schedule_date,schedule_time});
      logger.logScheduleChange(req.params.uid,'visit_rescheduled',{old_date:rows[0].schedule_date,new_date:schedule_date,old_time:rows[0].schedule_time,new_time:schedule_time},req.user?.email,req.user?.name).catch(()=>{});
      // Update calendar event time
      syncVisitCalendar(pool,{uid:req.params.uid,action:'update',actorUserId:req.user?.id}).catch(e=>console.error('Cal reschedule sync error:',e));
    }catch(e){console.error('Reschedule:',e);res.status(500).json({error:e.message})}
  });
  // Combined update: reassign + reschedule in one call
  router.post('/update/:uid',async(req,res)=>{
    try{
      const{field_exec,schedule_date,schedule_time}=req.body;
      const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      if(rows[0].visit_submitted_at)return res.status(400).json({error:'Visit already completed'});
      const sets=[];const vals=[];let n=1;
      if(field_exec){sets.push(`field_exec=$${n++}`);vals.push(field_exec)}
      if(schedule_date){
        const today=new Date().toISOString().split('T')[0];
        if(schedule_date<today)return res.status(400).json({error:'Cannot schedule in the past'});
        sets.push(`schedule_date=$${n++}`);vals.push(schedule_date);
      }
      if(schedule_time){sets.push(`schedule_time=$${n++}`);vals.push(schedule_time)}
      if(schedule_date&&dateStr(rows[0].schedule_date)!==dateStr(schedule_date)){
        sets.push(`visit_date_history=$${n++}`);vals.push(JSON.stringify(addReschedule(rows[0].visit_date_history,rows[0].schedule_date,schedule_date)));
      }
      if(!sets.length)return res.status(400).json({error:'Nothing to update'});
      sets.push(`updated_at=NOW()`);
      vals.push(req.params.uid);
      await pool.query(`UPDATE properties SET ${sets.join(',')} WHERE uid=$${n}`,vals);
      const resp={success:true,uid:req.params.uid};
      if(field_exec)resp.field_exec=field_exec;
      if(schedule_date)resp.schedule_date=schedule_date;
      if(schedule_time)resp.schedule_time=schedule_time;
      res.json(resp);
      // Log changes
      const old=rows[0];
      if(field_exec)logger.logScheduleChange(req.params.uid,'visit_reassigned',{old_exec:old.field_exec,new_exec:field_exec},req.user?.email,req.user?.name).catch(()=>{});
      if(schedule_date||schedule_time)logger.logScheduleChange(req.params.uid,'visit_rescheduled',{old_date:old.schedule_date,new_date:schedule_date||old.schedule_date,old_time:old.schedule_time,new_time:schedule_time||old.schedule_time},req.user?.email,req.user?.name).catch(()=>{});
      if(field_exec)notifyVisitReassigned(rows[0],field_exec,{email:req.user?.email,name:req.user?.name}).catch(e=>console.error('WA reassign notify error:',e));
      // Update calendar event (time and/or attendees)
      syncVisitCalendar(pool,{uid:req.params.uid,action:'update',actorUserId:req.user?.id}).catch(e=>console.error('Cal update sync error:',e));
    }catch(e){console.error('Update:',e);res.status(500).json({error:e.message})}
  });
  // Resend WhatsApp scheduled notification
  router.post('/notify/:uid',async(req,res)=>{
    try{
      const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      if(!rows[0].schedule_submitted_at)return res.status(400).json({error:'Schedule not submitted'});
      await notifyVisitScheduled(rows[0],{email:req.user?.email,name:req.user?.name});
      res.json({success:true,uid:req.params.uid});
    }catch(e){console.error('Notify:',e);res.status(500).json({error:e.message})}
  });
  return router;
};