// ── Openhouse v6 — Shared Utilities ──
const API=window.location.origin;

// ══════ TOAST ══════
function toast(msg,type='ok',ms=3500){document.querySelectorAll('.toast').forEach(t=>t.remove());
  const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=msg;document.body.appendChild(el);
  setTimeout(()=>{el.style.transition='opacity .3s';el.style.opacity='0';setTimeout(()=>el.remove(),300)},ms)}

// ══════ SELECTS / RADIOS / PILLS ══════
function fillSelect(sel,items,ph='Select...'){sel.innerHTML=`<option value="">${ph}</option>`;items.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;sel.appendChild(o)})}
function fillNumSelect(sel,min,max,ph='Select'){sel.innerHTML=`<option value="">${ph}</option>`;for(let i=min;i<=max;i++){const o=document.createElement('option');o.value=i;o.textContent=i;sel.appendChild(o)}}
// Floor select: Ground, 1..50, Top (floor is stored as text).
function fillFloorSelect(sel,ph='Select'){fillNumSelect(sel,1,50,ph);sel.add(new Option('Ground','Ground'),sel.options[1]);sel.add(new Option('Top','Top'))}
function fillRadios(c,name,vals,req=false){c.innerHTML='';vals.forEach(v=>{c.innerHTML+=`<label><input type="radio" name="${name}" value="${v}" ${req?'required':''}><span>${v}</span></label>`})}
function fillPills(c,name,vals,noneVal=null){
  c.innerHTML='';vals.forEach(v=>{c.innerHTML+=`<label><input type="checkbox" name="${name}" value="${v}"><span>${v}</span></label>`});
  if(noneVal){c.addEventListener('change',e=>{const cb=e.target;if(!cb.matches('input[type="checkbox"]'))return;
    if(cb.value===noneVal&&cb.checked){c.querySelectorAll(`input[name="${name}"]`).forEach(x=>{if(x.value!==noneVal)x.checked=false})}
    else if(cb.checked){const none=c.querySelector(`input[name="${name}"][value="${noneVal}"]`);if(none)none.checked=false}})}
}
function getCheckedJSON(name){return JSON.stringify([...document.querySelectorAll(`input[name="${name}"]:checked`)].map(c=>c.value))}
function getRadio(name){const c=document.querySelector(`input[name="${name}"]:checked`);return c?c.value:''}

// ══════ SEARCHABLE DROPDOWN ══════
function makeSearchable(sel){
  const wrap=document.createElement('div');wrap.className='sdd';sel.parentNode.insertBefore(wrap,sel);sel.style.display='none';wrap.appendChild(sel);
  const inp=document.createElement('input');inp.type='text';inp.className='sdd-in';inp.placeholder=sel.options[0]?.text||'Search...';inp.autocomplete='off';wrap.appendChild(inp);
  const list=document.createElement('div');list.className='sdd-list';wrap.appendChild(list);
  let items=[],open=false;
  function refresh(){items=[];for(let i=1;i<sel.options.length;i++)items.push({value:sel.options[i].value,text:sel.options[i].text,search:(sel.options[i].dataset.search||sel.options[i].text).toLowerCase()})}
  function render(f=''){const q=f.toLowerCase();const m=q?items.filter(v=>v.search.includes(q)||v.text.toLowerCase().includes(q)):items;
    list.innerHTML='';if(!m.length){list.innerHTML='<div class="sdd-empty">No results</div>';return}
    m.forEach(v=>{const d=document.createElement('div');d.className='sdd-item';d.textContent=v.text;d.addEventListener('mousedown',e=>{e.preventDefault();pick(v.value)});list.appendChild(d)})}
  function pick(v){sel.value=v;const opt=sel.options[sel.selectedIndex];inp.value=opt?opt.text:v;close();sel.dispatchEvent(new Event('change',{bubbles:true}))}
  function show(){if(sel.disabled)return;refresh();render(inp.value);list.style.display='block';open=true}
  function close(){list.style.display='none';open=false}
  inp.addEventListener('focus',show);inp.addEventListener('input',()=>{if(!open)show();render(inp.value)});
  inp.addEventListener('blur',()=>setTimeout(close,150));
  new MutationObserver(()=>{inp.value='';sel.value='';inp.placeholder=sel.options[0]?.text||'Search...';inp.disabled=sel.disabled}).observe(sel,{childList:true,attributes:true});
  return{pick,refresh};
}

// ══════ MULTI-SELECT (trimmed values) ══════
function makeMultiSelect(container,name,options){
  const selected=new Set();
  container.innerHTML=`<div class="msel"><input type="text" class="msel-search" placeholder="Search..."><div class="msel-opts"></div><div class="msel-count">0 selected</div></div>`;
  const optsEl=container.querySelector('.msel-opts'),search=container.querySelector('.msel-search'),countEl=container.querySelector('.msel-count');
  function renderOpts(q=''){optsEl.innerHTML='';options.filter(o=>o.toLowerCase().includes(q.toLowerCase())).forEach(o=>{
    const trimmed=o.trim();
    const label=document.createElement('label');label.className=`msel-opt${selected.has(trimmed)?' checked':''}`;
    label.innerHTML=`<input type="checkbox" value="${trimmed}" ${selected.has(trimmed)?'checked':''}><span>${o}</span>`;
    label.querySelector('input').addEventListener('change',function(){if(this.checked)selected.add(trimmed);else selected.delete(trimmed);updateCount();label.classList.toggle('checked',this.checked)});
    optsEl.appendChild(label)})}
  function updateCount(){countEl.textContent=`${selected.size} selected`}
  search.addEventListener('input',()=>renderOpts(search.value));renderOpts();
  return{getSelected:()=>JSON.stringify([...selected]),setSelected(arr){arr.forEach(v=>{const t=typeof v==='string'?v.trim():v;if(options.map(o=>o.trim()).includes(t))selected.add(t)});updateCount();renderOpts(search.value)}};
}

// ══════ CASCADE ══════
async function loadCities(sel){try{const r=await fetch(`${API}/api/config/cities`);fillSelect(sel,await r.json(),'Select City')}catch(e){toast('Failed to load cities','err')}}
async function loadSocieties(city,socSel,locSel){socSel.innerHTML='<option value="">Loading...</option>';socSel.disabled=true;if(locSel){locSel.innerHTML='<option value="">Select society first</option>';locSel.disabled=true}
  if(!city){socSel.innerHTML='<option value="">Select city first</option>';return}
  try{const r=await fetch(`${API}/api/config/societies?city=${encodeURIComponent(city)}`);fillSelect(socSel,await r.json(),'Search society...');socSel.disabled=false}catch(e){toast('Failed','err')}}
async function loadLocalities(city,soc,locSel){locSel.innerHTML='<option value="">Loading...</option>';locSel.disabled=true;
  if(!city||!soc){locSel.innerHTML='<option value="">Select society first</option>';return}
  try{const r=await fetch(`${API}/api/config/localities?city=${encodeURIComponent(city)}&society=${encodeURIComponent(soc)}`);const l=await r.json();fillSelect(locSel,l,'Select Locality');locSel.disabled=false;if(l.length===1)locSel.value=l[0]}catch(e){toast('Failed','err')}}
function setupCascade(cityEl,socEl,locEl){cityEl.addEventListener('change',()=>loadSocieties(cityEl.value,socEl,locEl));socEl.addEventListener('change',()=>loadLocalities(cityEl.value,socEl.value,locEl))}

// ══════ STEPPER + PROGRESS ══════
function makeStepper(total,progEl){
  let cur=1;
  function update(p){document.querySelectorAll('.page').forEach(el=>el.classList.remove('active'));
    const pg=document.getElementById(`p${p}`);if(pg)pg.classList.add('active');
    document.querySelectorAll('.step').forEach((s,i)=>{s.classList.remove('active','done');if(i+1===p)s.classList.add('active');else if(i+1<p)s.classList.add('done')});
    document.querySelectorAll('.step-line').forEach((l,i)=>l.classList.toggle('done',i+1<p));
    if(progEl){const pct=Math.round(((p-1)/(total-1))*100);progEl.querySelector('.prog-fill').style.width=pct+'%';progEl.querySelector('.prog-lbl').textContent=pct+'% complete'}
    cur=p;window.scrollTo({top:0,behavior:'smooth'})}
  return{show(p){update(p)},next(){if(cur<total)update(cur+1);return cur},prev(){if(cur>1)update(cur-1)},get current(){return cur}};
}

// ══════ VALIDATION ══════
function validatePage(pid){const pg=document.getElementById(pid);if(!pg)return true;let ok=true;pg.querySelectorAll('.fg.invalid').forEach(f=>f.classList.remove('invalid'));
  pg.querySelectorAll('[required]').forEach(el=>{const fg=el.closest('.fg');if(!fg)return;
    if(el.type==='radio'){if(!pg.querySelector(`input[name="${el.name}"]:checked`)&&fg.querySelector(`input[name="${el.name}"]`)===el){fg.classList.add('invalid');ok=false}}
    else if(!el.value.trim()){fg.classList.add('invalid');ok=false}});
  if(!ok)toast('Fill all required fields','err');return ok}
function validateForm(fid){const form=document.getElementById(fid);if(!form)return{valid:true,missing:[]};const miss=[];
  form.querySelectorAll('.fg.invalid').forEach(f=>f.classList.remove('invalid'));
  form.querySelectorAll('[required]').forEach(el=>{const fg=el.closest('.fg');if(!fg)return;
    if(el.type==='radio'){if(!form.querySelector(`input[name="${el.name}"]:checked`)){fg.classList.add('invalid');const l=fg.querySelector('label');if(l)miss.push(l.textContent.replace('*','').trim())}}
    else if(!el.value.trim()){fg.classList.add('invalid');const l=fg.querySelector('label');if(l)miss.push(l.textContent.replace('*','').trim())}});
  return{valid:miss.length===0,missing:miss}}

// Auto-clear red border on input
document.addEventListener('input',e=>{const fg=e.target.closest('.fg');if(fg&&fg.classList.contains('invalid')&&e.target.value.trim())fg.classList.remove('invalid')});
document.addEventListener('change',e=>{const fg=e.target.closest('.fg');if(fg&&fg.classList.contains('invalid')&&e.target.value)fg.classList.remove('invalid')});

// ══════ IMAGE UPLOAD (Cloudinary) ══════
function initImageUpload(zoneId,previewsId,max=10){
  const zone=document.getElementById(zoneId),previews=document.getElementById(previewsId),urls=[];let cfg=null;
  fetch(`${API}/api/config/cloudinary`).then(r=>r.json()).then(c=>cfg=c).catch(()=>{});
  const fi=document.createElement('input');fi.type='file';fi.accept='image/*';fi.multiple=true;
  zone.addEventListener('click',()=>fi.click());
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('dragover')});
  zone.addEventListener('dragleave',()=>zone.classList.remove('dragover'));
  zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('dragover');handleFiles(e.dataTransfer.files)});
  fi.addEventListener('change',()=>{handleFiles(fi.files);fi.value=''});
  async function handleFiles(files){if(!cfg||!cfg.cloudName){toast('Cloudinary not configured','warn');return}for(const f of files){if(urls.length>=max){toast(`Max ${max} images`,'warn');break}await uploadOne(f)}}
  async function uploadOne(file){const ld=document.createElement('div');ld.className='img-uploading';ld.innerHTML='<span class="spin"></span> Uploading...';previews.appendChild(ld);
    try{const fd=new FormData();fd.append('file',file);fd.append('upload_preset',cfg.uploadPreset);
      const r=await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`,{method:'POST',body:fd});if(!r.ok)throw new Error();
      const d=await r.json();urls.push(d.secure_url);addThumb(d.secure_url)}catch(e){toast('Upload failed','err')}finally{ld.remove()}}
  function addThumb(url){const d=document.createElement('div');d.className='img-thumb';
    d.innerHTML=`<img src="${url}"><button type="button" class="rm">✕</button>`;
    d.querySelector('.rm').addEventListener('click',()=>{const i=urls.indexOf(url);if(i>-1)urls.splice(i,1);d.remove()});previews.appendChild(d)}
  return{getUrls:()=>JSON.stringify(urls),setUrls(arr){arr.forEach(u=>{urls.push(u);addThumb(u)})}};
}

// ══════ SINGLE IMAGE UPLOAD — Camera + Gallery chooser ══════
function initSingleUpload(btnId,previewId,urlInputId){
  let cfg=null,currentUrl='';
  fetch(`${API}/api/config/cloudinary`).then(r=>r.json()).then(c=>cfg=c).catch(()=>{});
  const btn=document.getElementById(btnId),prev=document.getElementById(previewId),urlInp=document.getElementById(urlInputId);

  // Two hidden file inputs: one for camera, one for gallery
  const fiCam=document.createElement('input');fiCam.type='file';fiCam.accept='image/*';fiCam.setAttribute('capture','environment');
  const fiGal=document.createElement('input');fiGal.type='file';fiGal.accept='image/*';

  // Popup chooser
  function showChooser(){
    // Remove any existing chooser
    document.querySelectorAll('.img-chooser').forEach(c=>c.remove());
    const chooser=document.createElement('div');chooser.className='img-chooser';
    chooser.innerHTML=`<button type="button" class="img-chooser-btn" data-mode="cam">📷 Camera</button><button type="button" class="img-chooser-btn" data-mode="gal">🖼 Gallery</button>`;
    chooser.style.cssText='display:flex;gap:6px;margin-top:6px';
    chooser.querySelectorAll('.img-chooser-btn').forEach(b=>{
      b.style.cssText='flex:1;padding:8px;border:1px solid var(--bd);border-radius:var(--r);background:var(--sf);font-size:12px;cursor:pointer';
      b.addEventListener('click',e=>{e.stopPropagation();if(b.dataset.mode==='cam')fiCam.click();else fiGal.click();chooser.remove()})
    });
    btn.parentNode.insertBefore(chooser,btn.nextSibling);
    // Auto-close after 5s
    setTimeout(()=>chooser.remove(),5000);
  }

  btn.addEventListener('click',showChooser);

  async function handleFile(file){
    if(!file)return;if(!cfg||!cfg.cloudName){toast('Cloudinary not configured','warn');return}
    btn.textContent='Uploading...';btn.disabled=true;
    try{const fd=new FormData();fd.append('file',file);fd.append('upload_preset',cfg.uploadPreset);
      const r=await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`,{method:'POST',body:fd});if(!r.ok)throw new Error();
      const d=await r.json();currentUrl=d.secure_url;urlInp.value=currentUrl;
      prev.querySelector('img').src=currentUrl;prev.classList.add('show');toast('Uploaded!','ok')}
    catch(e){toast('Upload failed','err')}finally{btn.textContent='Upload';btn.disabled=false}
  }

  fiCam.addEventListener('change',()=>{if(fiCam.files.length)handleFile(fiCam.files[0]);fiCam.value=''});
  fiGal.addEventListener('change',()=>{if(fiGal.files.length)handleFile(fiGal.files[0]);fiGal.value=''});

  return{getUrl:()=>currentUrl,setUrl(u){if(u){currentUrl=u;urlInp.value=u;prev.querySelector('img').src=u;prev.classList.add('show')}}};
}

// ══════ CHEQUE OCR ══════
async function ocrCheque(imageUrl){
  try{const r=await fetch(`${API}/api/ocr/cheque`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageUrl})});
    const d=await r.json();if(!r.ok)throw new Error(d.error);return d}catch(e){toast('OCR failed: '+e.message,'err');return{extracted:false,bank_name:'',account_number:'',ifsc_code:''}}
}

// ══════ DOUBLE-TAP EDIT ══════
function enableDoubleTapEdit(container){let lastTap=0;
  container.querySelectorAll('.pre').forEach(inp=>{
    inp.addEventListener('touchend',()=>{const now=Date.now();if(now-lastTap<300){makeEditable(inp)}lastTap=now});
    inp.addEventListener('dblclick',()=>makeEditable(inp))});
  function makeEditable(inp){inp.readOnly=false;inp.classList.remove('pre');inp.classList.add('editable-field','editing');inp.focus();
    inp.addEventListener('blur',()=>{inp.readOnly=true;inp.classList.add('pre');inp.classList.remove('editing')},{once:true})}
}

// ══════ CONTACT VALIDATION ══════
function setupContactValidation(inputId,errId){
  const inp=document.getElementById(inputId),err=document.getElementById(errId);
  inp.addEventListener('input',()=>{
    inp.value=inp.value.replace(/\D/g,'');
    const len=inp.value.length;
    if(len>0&&inp.value[0]==='0'){err.textContent='Cannot start with 0';err.classList.add('show')}
    else if(len>0&&len<10){err.textContent=`${10-len} more digits needed`;err.classList.add('show')}
    else{err.classList.remove('show')}
  });
}

// ══════ SUBMIT BUTTON ══════
async function submitBtn(btn,fn){const o=btn.innerHTML;btn.disabled=true;btn.innerHTML='<span class="spin"></span> ...';try{await fn()}catch(e){toast(e.message||'Failed','err')}finally{btn.disabled=false;btn.innerHTML=o}}

// ══════ N/A TOGGLE ══════
function toggleNA(fieldId,label='N/A'){const inp=document.getElementById(fieldId),cb=document.getElementById(fieldId+'_na');
  if(cb.checked){inp.value='';inp.disabled=true;inp.placeholder=label;inp.dataset.na='1'}else{inp.disabled=false;inp.placeholder='₹';inp.dataset.na=''}}

// ══════ THANK YOU OVERLAY ══════
function showThankYou(uid,customActions){
  let ov=document.getElementById('tyOverlay');
  if(!ov){ov=document.createElement('div');ov.id='tyOverlay';ov.className='ty-overlay';document.body.appendChild(ov)}
  const actions=customActions||`<a href="${window.location.pathname}" class="ty-back">← Back to Form</a>`;
  ov.innerHTML=`<div class="ty-icon">✓</div><div class="ty-title">Thank you!</div><div class="ty-sub">Your response has been submitted.</div>${uid?`<div class="ty-uid">UID : ${uid}</div>`:''}<div class="ty-actions">${actions}</div>`;
  ov.classList.add('show');
}

// ══════ UID SELECT WITH RICH LABELS ══════
function fillUidSelect(sel,uids){
  sel.innerHTML='<option value="">Select UID...</option>';
  uids.forEach(u=>{
    const label=`${u.uid} — ${u.society_name||''}, ${u.tower_no?u.tower_no+'-':''}${u.unit_no||''}`;
    const o=document.createElement('option');o.value=u.uid;o.textContent=label;o.dataset.search=`${u.uid} ${u.society_name||''} ${u.tower_no||''} ${u.unit_no||''}`.toLowerCase();sel.appendChild(o);
  });
}

// ══════ DATE MAX TODAY ══════
function noFutureDate(inputId){const inp=document.getElementById(inputId);if(inp){inp.max=new Date().toISOString().split('T')[0];inp.addEventListener('change',()=>{if(inp.value>inp.max){inp.value=inp.max;toast('Future dates not allowed','warn')}})}}

// ══════ CONFIG DISPLAY ══════
function configDisplay(config,extraArea){
  if(!config)return '—';if(!config.includes('.5'))return config;
  let extras=[];try{extras=typeof extraArea==='string'?JSON.parse(extraArea):extraArea||[]}catch(e){}
  extras=extras.filter(e=>e!=='No Extra Room');
  return extras.length?`${config} (${extras.join(', ')})`:config;
}

// ══════ LIVE COMMA FORMATTING ══════
function commaFormat(v){if(!v)return '';const n=v.replace(/[^0-9.]/g,'');if(!n)return '';const parts=n.split('.');const int=parts[0];const dec=parts.length>1?'.'+parts[1]:'';
  const last3=int.slice(-3);const rest=int.slice(0,-3);const formatted=rest.replace(/\B(?=(\d{2})+(?!\d))/g,',')+((rest?',':'')+last3);return formatted+dec}
function setupCommaField(inp){
  inp.addEventListener('input',function(){const pos=this.selectionStart;const old=this.value;const stripped=old.replace(/,/g,'');
    const formatted=commaFormat(stripped);this.value=formatted;
    const diff=formatted.length-old.length;this.setSelectionRange(pos+diff,pos+diff)});
}
function getCommaValue(inp){return(inp.value||'').replace(/,/g,'')}

// Apply to amount fields on page load
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('input[type="number"]').forEach(inp=>{
    const n=(inp.name||'').toLowerCase();
    if(n.includes('amount')||n.includes('price')||n.includes('loan')||n.includes('guarantee')||n.includes('outstanding')){
      inp.type='text';inp.inputMode='decimal';setupCommaField(inp)}
  });
});

// ══════ RESEND WARNING CONFIRM ══════
function confirmResend(msg='Email has Already been sent'){
  return new Promise(resolve=>{
    const ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px';
    ov.innerHTML=`<div style="background:var(--sf,#fff);border-radius:12px;max-width:340px;width:100%;padding:22px;box-shadow:0 12px 40px rgba(0,0,0,.25);text-align:center">
      <div style="font-size:34px;line-height:1">⚠️</div>
      <div style="font-weight:700;font-size:16px;margin:10px 0 4px;color:var(--tx,#111)">${msg}</div>
      <div style="font-size:13px;color:var(--tx3,#666);margin-bottom:18px">Do you want to send it again?</div>
      <div style="display:flex;gap:10px">
        <button type="button" class="cr-cancel" style="flex:1;padding:10px;border:1px solid var(--bd,#ddd);border-radius:8px;background:var(--sf,#fff);color:var(--tx,#111);font-size:14px;cursor:pointer">Cancel</button>
        <button type="button" class="cr-ok" style="flex:1;padding:10px;border:none;border-radius:8px;background:#d9534f;color:#fff;font-size:14px;cursor:pointer">Continue Anyway</button>
      </div></div>`;
    document.body.appendChild(ov);
    const done=v=>{ov.remove();resolve(v)};
    ov.querySelector('.cr-cancel').addEventListener('click',()=>done(false));
    ov.querySelector('.cr-ok').addEventListener('click',()=>done(true));
    ov.addEventListener('click',e=>{if(e.target===ov)done(false)});
  });
}

// ══════ IFSC → BANK NAME LOOKUP ══════
const IFSC_BANK_MAP={SBIN:'State Bank of India',PUNB:'Punjab National Bank',ICIC:'ICICI Bank',UTIB:'Axis Bank',KKBK:'Kotak Mahindra',HDFC:'HDFC Bank',YESB:'Yes Bank',CITI:'Citi Bank',BARB:'Bank of Baroda',CNRB:'Canara Bank',UBIN:'Union Bank',IOBA:'Indian Overseas Bank',BKID:'Bank of India'};
function bankFromIFSC(ifsc){if(!ifsc||ifsc.length<4)return '';const prefix=ifsc.substring(0,4).toUpperCase();return IFSC_BANK_MAP[prefix]||''}