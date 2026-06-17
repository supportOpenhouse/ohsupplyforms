const express=require('express'),router=express.Router();
module.exports=function(pool){
  const OPT={
    sources:["CP","Direct"],
    configurations:["2 BHK","2.5 BHK","3 BHK","3.5 BHK","4 BHK"],
    extraAreas:["Basement","Lawn","Terrace","Servant Room","Store Room","Study Room","Pooja Room","No Extra Room"],
    possessionStatuses:["Owner Staying","Tenant","Vacant"],
    parkingOptions:["1 Open","1 Closed","2 Open","2 Closed","1 Open + 1 Closed","Stilt Parking","No Parking"],
    furnishingLevels:["Unfurnished","Semi-Furnished","Fully Furnished"],
    furnishingDetails:["Lights","Fans","Modular Kitchen","Chimney","Almirahs","ACs","Geysers"],
    directions:["North","South","East","West","North-East","North-West","South-East","South-West"],
    balconyViews:["Road","Club","Garden","Park/Playground","Swimming Pool","Open Area","Other Building","Tower","N/A"],
    balconyAttach:["Master Bedroom","2nd Bedroom","3rd Bedroom","Living Room","Kitchen"],
    documentsAvailable:["  Allotment Letter issued by the Builder","  Possession Letter/Certificate by the Builder","  Builder Buyer Agreement","  Conveyance Deed/Sub Lease Deed/Sale Deed","  Other Documents"],
    banks:["Au Small Finance Bank Ltd.","Axis Bank Ltd.","Bandhan Bank Ltd.","Bank of Baroda","Bank of India","Bank of Maharashtra","Bajaj Housing Finance","Canara Bank","Central Bank of India","City Union Bank Ltd.","CSB Bank Limited","DCB Bank Ltd.","Dhanlaxmi Bank Ltd.","Federal Bank Ltd.","Godrej Housing Finance","HDFC Bank Ltd","HSBC India","ICICI Bank Ltd.","IDBI Bank Limited","IDFC FIRST Bank Limited","Indian Bank","Indian Overseas Bank","IndusInd Bank Ltd","Jammu & Kashmir Bank Ltd.","Karnataka Bank Ltd.","Karur Vysya Bank Ltd.","Kotak Mahindra Bank Ltd","Nainital bank Ltd.","Punjab & Sind Bank","Punjab National Bank","RBL Bank Ltd.","South Indian Bank Ltd.","Standard Charted India","State Bank of India","Tamilnad Mercantile Bank Ltd.","UCO Bank","Union Bank of India","Utkarsh Small Finance Bank Limited","YES Bank Ltd."],
    yesNo:["Yes","No"],
    cityMap:{"Gurgaon":"G","Noida":"N","Ghaziabad":"GH"},
    sourceMap:{"CP":"C","Direct":"D"},
    assignedByList: [],
    assignedToList: []
  };
  router.get('/',async(_,r)=>{
    try{
      const abRows=await pool.query(`SELECT name FROM users WHERE can_assign=TRUE AND is_active=TRUE ORDER BY name`);
      const atRows=await pool.query(`SELECT name FROM users WHERE can_visit=TRUE AND is_active=TRUE ORDER BY name`);
      OPT.assignedByList=abRows.rows.map(x=>x.name).filter(Boolean);
      OPT.assignedToList=atRows.rows.map(x=>x.name).filter(Boolean);
      // Fallback: if DB has no roles yet, keep hardcoded defaults
      if(!OPT.assignedByList.length)OPT.assignedByList=["Abhishek Rathore","Aman Dixit","Animesh Singh","Arti Ahirwar","Deepak Mishra","Deepak Rana","Kavita Rawat","Nisha Deewan","Rahul Sheel","Rupali Prasad","Sahil Singh","Shashank Kumar","Sushmita Roy","Test Sahaj"];
      if(!OPT.assignedToList.length)OPT.assignedToList=["Aman Dixit","Animesh Singh","Ashwani Sharma","Deepak Mishra","Deepak Rana","Manish Sharma","Nishant Kumar","Praveen Kumar","Rahul Sheel","Rahul Singh","Sahil Singh","Test Sahaj"];
      r.json({options:OPT});
    }catch(e){r.json({options:OPT})}
  });
  router.get('/cloudinary',(_,r)=>r.json({cloudName:process.env.CLOUDINARY_CLOUD_NAME||'',uploadPreset:process.env.CLOUDINARY_UPLOAD_PRESET||''}));
  router.get('/cities',async(_,r)=>{try{const{rows}=await pool.query('SELECT DISTINCT city FROM master_societies ORDER BY city');r.json(rows.map(x=>x.city))}catch(e){r.status(500).json({error:e.message})}});
  router.get('/societies',async(q,r)=>{try{if(!q.query.city)return r.status(400).json({error:'city required'});const{rows}=await pool.query('SELECT DISTINCT society_name FROM master_societies WHERE city=$1 ORDER BY society_name',[q.query.city]);r.json(rows.map(x=>x.society_name))}catch(e){r.status(500).json({error:e.message})}});
  router.get('/localities',async(q,r)=>{try{const{city,society}=q.query;if(!city||!society)return r.status(400).json({error:'city+society required'});const{rows}=await pool.query('SELECT DISTINCT locality FROM master_societies WHERE city=$1 AND society_name=$2 ORDER BY locality',[city,society]);r.json(rows.map(x=>x.locality))}catch(e){r.status(500).json({error:e.message})}});
  router.get('/areas',async(q,r)=>{try{if(!q.query.society)return r.status(400).json({error:'society required'});const{rows}=await pool.query('SELECT area_sqft FROM master_areas WHERE society_name=$1 ORDER BY area_sqft',[q.query.society]);r.json(rows.map(x=>x.area_sqft))}catch(e){r.status(500).json({error:e.message})}});
  return router;
};