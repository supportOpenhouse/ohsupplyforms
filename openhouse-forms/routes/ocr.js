const express=require('express'),router=express.Router();

module.exports=function(){
  // Accepts {imageUrl} or {imageBase64}, calls Google Vision, extracts bank details
  router.post('/cheque',async(req,res)=>{
    try{
      const apiKey=process.env.GOOGLE_VISION_API_KEY;
      if(!apiKey)return res.status(500).json({error:'Google Vision API key not configured'});
      const{imageUrl,imageBase64}=req.body;
      if(!imageUrl&&!imageBase64)return res.status(400).json({error:'Image required'});

      // Build Vision API request. A cheque in the private KYC bucket (gs:// reference,
      // or a signed URL of ours) can't be fetched by Vision, so its bytes are sent.
      const kycstore=require('../utils/kycstore');
      const kycName=imageUrl?kycstore.nameFromRef(imageUrl):null;
      const imageObj=kycName?{content:(await kycstore.read(kycName)).buffer.toString('base64')}
        :imageUrl?{source:{imageUri:imageUrl}}:{content:imageBase64};
      const body={requests:[{image:imageObj,features:[{type:'TEXT_DETECTION',maxResults:1}]}]};

      const r=await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await r.json();
      if(data.error)return res.status(500).json({error:data.error.message});

      const text=(data.responses&&data.responses[0]&&data.responses[0].fullTextAnnotation&&data.responses[0].fullTextAnnotation.text)||'';
      if(!text)return res.json({extracted:false,raw:'',bank_name:'',account_number:'',ifsc_code:''});

      // Parse bank details from OCR text
      const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
      let bank_name='',account_number='',ifsc_code='';

      // IFSC: 11 chars, 4 alpha + 0 + 6 alphanumeric (case-insensitive, also look near "IFS" label)
      const ifscMatch=text.toUpperCase().match(/[A-Z]{4}0[A-Z0-9]{6}/);
      if(ifscMatch)ifsc_code=ifscMatch[0];
      if(!ifsc_code){for(const line of lines){if(/ifs/i.test(line)){const m=line.toUpperCase().match(/[A-Z]{4}0[A-Z0-9]{6}/);if(m){ifsc_code=m[0];break}}}}

      // Account number: long digit sequence (9-18 digits)
      const acMatches=text.match(/\b\d{9,18}\b/g);
      if(acMatches){
        // Pick the longest numeric string as account number
        account_number=acMatches.sort((a,b)=>b.length-a.length)[0]||'';
      }

      // Bank name: look for common patterns
      const bankPatterns=['bank','BANK','Bank'];
      for(const line of lines){
        if(bankPatterns.some(p=>line.includes(p))){bank_name=line;break}
      }
      // Fallback: first line is often bank name
      if(!bank_name&&lines.length>0)bank_name=lines[0];

      res.json({extracted:true,raw:text,bank_name,account_number,ifsc_code});
    }catch(e){console.error('OCR:',e);res.status(500).json({error:'OCR failed: '+e.message})}
  });
  return router;
};
