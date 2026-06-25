const express=require('express'),router=express.Router();
const logger=require('../utils/logger');
const{visibilityFilter}=require('../utils/visibility');

function toArray(value){
  if(Array.isArray(value))return value;
  if(value==null||value==='')return [];
  if(typeof value==='string'){
    try{
      const parsed=JSON.parse(value);
      return Array.isArray(parsed)?parsed:[];
    }catch(_){
      return [];
    }
  }
  return [];
}

function parseLayoutConfig(configuration){
  const raw=(configuration||'').toString().trim();
  const m=raw.match(/(\d+)/);
  if(!m)return 2;
  const n=parseInt(m[1],10);
  if(!Number.isFinite(n))return 2;
  return Math.max(1,Math.min(500,n));
}

function deriveStudyRoomCount(extraAreaRaw){
  const items=toArray(extraAreaRaw).map(x=>String(x||'').trim().toLowerCase());
  return items.some(x=>x.includes('study'))?1:0;
}

function derivePoojaRoomCount(extraAreaRaw){
  const items=toArray(extraAreaRaw).map(x=>String(x||'').trim().toLowerCase());
  return items.some(x=>x.includes('pooja')||x.includes('puja'))?1:0;
}

function deriveServantQtrCount(extraAreaRaw){
  const items=toArray(extraAreaRaw).map(x=>String(x||'').trim().toLowerCase());
  return items.some(x=>x.includes('servant'))?1:0;
}

function mapFurnishingStatus(furnishing){
  const val=(furnishing||'').toString().trim().toLowerCase();
  if(!val)return null;
  if(val.includes('unfurnished'))return 'Unfurnished';
  if(val.includes('semi'))return 'Semi Furnished';
  if(val.includes('full')||val.includes('furnished'))return 'Fully Furnished';
  return null;
}

function buildUpdatePayload(row){
  const balconyDetails=toArray(row.balcony_details);
  const balconyViewNames=[...new Set(
    balconyDetails
      .map(x=>x&&x.view?String(x.view).trim():'')
      .filter(v=>v&&v.toLowerCase()!=='n/a')
  )];
  const furnishingDetails=toArray(row.furnishing_details);
  const furnishingItems=[...new Set(
    furnishingDetails
      .map(x=>String(x||'').trim())
      .filter(Boolean)
  )].map(name=>({name,count:1}));

  const configuration=(row.configuration||'').toString().trim();
  const layoutConfig=parseLayoutConfig(configuration);

  return{
    supply_form_uid:row.uid,
    property_type_name:'Flat/Apartment',
    facing:row.exit_facing||null,
    balcony_view_names:balconyViewNames,
    furnishing_status:mapFurnishingStatus(row.furnishing),
    furnishing_items:furnishingItems,
    layout_name:configuration||`${layoutConfig}BHK`,
    layout_config:layoutConfig,
    bathroom_count:row.bathrooms!=null?parseInt(row.bathrooms,10):null,
    balcony_count:row.balconies!=null?parseInt(row.balconies,10):null,
    pooja_room:derivePoojaRoomCount(row.extra_area),
    study_room:deriveStudyRoomCount(row.extra_area),
    servant_qtr:deriveServantQtrCount(row.extra_area),
    super_area:row.super_area!=null?parseInt(parseFloat(row.super_area),10):null,
    carpet_area:row.carpet_area!=null?parseInt(parseFloat(row.carpet_area),10):null,
  };
}

module.exports=function(pool){
  router.get('/prefill/:uid',async(req,res)=>{
    try{const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      if(!rows[0].pending_request_submitted_at)return res.status(400).json({error:'AMA Acknowledgement (Form 6) must be submitted first'});
      res.json(rows[0])}catch(e){res.status(500).json({error:e.message})}
  });
  router.get('/uids',async(req,res)=>{
    try{const vis=visibilityFilter(req.user);const{rows}=await pool.query(`SELECT uid,city,society_name,unit_no,tower_no,owner_broker_name,pending_request_submitted_at,listing_submitted_at
      FROM properties WHERE pending_request_submitted_at IS NOT NULL AND is_dead IS NOT TRUE AND is_token_refunded IS NOT TRUE AND replicated IS NOT TRUE${vis.clause} ORDER BY created_at DESC`,vis.params);res.json(rows)}catch(e){res.status(500).json({error:e.message})}
  });
  router.post('/submit',async(req,res)=>{
    try{
      const d=req.body;const{rows}=await pool.query('SELECT uid FROM properties WHERE uid=$1',[d.uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      await pool.query(`UPDATE properties SET
        maintenance_charges=$1,society_move_in_charges=$2,
        electricity_charges=$3,dg_charges=$4,
        seller_location=$5,super_area=$6,carpet_area=$7,
        gas_pipeline=$8,club_facility=$9,
        seller_residential_status=$10,sellers_available_on_registry=$11,
        listing_submitted_at=NOW(),updated_at=NOW() WHERE uid=$12`,
        [parseFloat(d.maintenance_charges)||null,parseFloat(d.society_move_in_charges)||null,
         parseFloat(d.electricity_charges)||null,parseFloat(d.dg_charges)||null,
         d.seller_location||null,parseFloat(d.super_area)||null,parseFloat(d.carpet_area)||null,
         d.gas_pipeline||null,d.club_facility||null,
         d.seller_residential_status||null,d.sellers_available_on_registry||null,d.uid]);
      res.json({success:true,uid:d.uid});
      logger.logFormSubmit(d.uid,'listing_submitted',9,req.user?.email,req.user?.name).catch(()=>{});
    }catch(e){console.error('Listing:',e);res.status(500).json({error:e.message})}
  });
  
  router.post('/update-seller-dashboard',async(req,res)=>{
    const tag='[listing/update-seller-dashboard]';
    try{
      const uid=(req.body&&req.body.uid)?String(req.body.uid).trim():'';
      if(!uid)return res.status(400).json({error:'uid is required'});

      const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[uid]);
      if(!rows.length)return res.status(404).json({error:'UID not found'});
      const row=rows[0];

      if(!row.core_home_id){
        return res.status(400).json({error:'Core home not linked yet. Run Create Seller Dashboard first.'});
      }
      if(!row.listing_submitted_at){
        return res.status(400).json({error:'Submit Listing first before updating seller dashboard.'});
      }

      const coreBase=(process.env.CORE_API_BASE_URL||'').replace(/\/$/,'');
      const apiKey=(process.env.SUPPLY_FORM_API_KEY||'').trim();
      if(!coreBase||!apiKey){
        return res.status(503).json({error:'Core integration not configured on this server'});
      }

      const payload=buildUpdatePayload(row);
      console.log(tag,'payload_to_core',JSON.stringify(payload));

      const url=`${coreBase}/api/v1/oh/supply-form/update-home/`;
      const r=await fetch(url,{
        method:'POST',
        headers:{'Content-Type':'application/json','X-Supply-Form-Key':apiKey},
        body:JSON.stringify(payload),
      });
      let j={};
      try{j=await r.json();}catch(_){}
      console.log(tag,'core_response',{status:r.status,bodyPreview:JSON.stringify(j).slice(0,4000)});

      if(!r.ok){
        return res.status(r.status).json({
          error:j.error||j.message||'Core update request failed',
          details:j.details||j,
          trace:j.trace,
        });
      }

      logger.logFormSubmit(uid,'listing_dashboard_updated',9,req.user?.email,req.user?.name).catch(()=>{});
      return res.status(r.status).json({...j,uid});
    }catch(e){
      console.error('[listing/update-seller-dashboard] exception',e);
      return res.status(500).json({error:e.message});
    }
  });

  return router;
};