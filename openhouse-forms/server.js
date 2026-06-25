require('dotenv').config();

// ── Fix ERR_STREAM_PREMATURE_CLOSE on Google API calls ────────────────────────────
// Node 19+ defaults the global HTTP(S) agent to keepAlive:true. Reused keep-alive
// sockets to Google (oauth2.googleapis.com token refresh AND gmail.googleapis.com) get
// closed mid-request by Google's LB → "Invalid response body … Premature close". This
// runs BEFORE any module makes a request, forcing a fresh socket per request app-wide
// (covers google-auth's internal token-refresh transport, which per-request options
// can't reach). Slightly less connection reuse; far more reliable.
const http = require('http');
const https = require('https');
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const pool = require('./db/pool');
const { MIGRATION_SQL, COMPAT_SQL, LOGS_TABLE_SQL } = require('./db/migrate');
const { SOCIETIES } = require('./db/seed');
const { isAuthenticated, hasFormAccess, isAdmin, hasAdminPanelAccess } = require('./middleware/auth');
const { visibilityFilter } = require('./utils/visibility');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors()); app.use(express.json({limit:'10mb'})); app.use(express.urlencoded({extended:true}));

app.set('trust proxy', 1);
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'openhouse-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' || process.env.APP_URL?.startsWith('https'), maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try { const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]); done(null, rows[0] || null); }
  catch (e) { done(e, null); }
});

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  const callbackURL = (process.env.APP_URL || `http://localhost:${PORT}`) + '/auth/google/callback';
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase();
      if (!email) return done(null, false);
      const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email)=$1 AND is_active=TRUE', [email]);
      if (!rows.length) return done(null, false);
      const updates = []; const vals = []; let idx = 1;
      if (!rows[0].name && profile.displayName) { updates.push(`name=$${idx++}`); vals.push(profile.displayName); }
      if (accessToken) { updates.push(`google_access_token=$${idx++}`); vals.push(accessToken); }
      if (refreshToken) { updates.push(`google_refresh_token=$${idx++}`); vals.push(refreshToken); }
      if (updates.length) {
        vals.push(rows[0].id);
        await pool.query(`UPDATE users SET ${updates.join(',')} WHERE id=$${idx}`, vals);
        if (accessToken) rows[0].google_access_token = accessToken;
        if (refreshToken) rows[0].google_refresh_token = refreshToken;
        if (!rows[0].name && profile.displayName) rows[0].name = profile.displayName;
      }
      return done(null, rows[0]);
    } catch (e) { return done(e, null); }
  }));
}

app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

app.use('/auth', require('./routes/auth')(pool));
app.get('/login', (_, r) => r.sendFile(path.join(__dirname, 'public/login.html')));

app.use('/api/config', isAuthenticated, require('./routes/config')(pool));
app.use('/api/schedule', isAuthenticated, hasFormAccess, require('./routes/schedule')(pool));
app.use('/api/visit', isAuthenticated, hasFormAccess, require('./routes/visit')(pool));
app.use('/api/token-request', isAuthenticated, hasFormAccess, require('./routes/token-request')(pool));
app.use('/api/token-deal', isAuthenticated, hasFormAccess, require('./routes/token-deal')(pool));
app.use('/api/ama-details', isAuthenticated, hasFormAccess, require('./routes/ama-details')(pool));
app.use('/api/pending-request', isAuthenticated, hasFormAccess, require('./routes/pending-request')(pool));
app.use('/api/final', isAuthenticated, hasFormAccess, require('./routes/final')(pool));
app.use('/api/listing', isAuthenticated, hasFormAccess, require('./routes/listing')(pool));
app.use('/api/cp-bill', isAuthenticated, hasFormAccess, require('./routes/cp-bill')(pool));
app.use('/api/ocr', isAuthenticated, require('./routes/ocr')());
// External integrations — uses X-Internal-Key header auth, NO session auth
app.use('/api/external', require('./routes/external')(pool));

app.get('/api/properties', isAuthenticated, hasAdminPanelAccess, async(req,res)=>{
  try{const vis=visibilityFilter(req.user);const{rows}=await pool.query(`SELECT uid,lead_id,city,locality,society_name,unit_no,tower_no,configuration,owner_broker_name,first_name,last_name,contact_no,
    assigned_by,field_exec,token_requested_by,is_dead,is_token_refunded,schedule_date,schedule_time,
    schedule_submitted_at,visit_submitted_at,token_submitted_at,token_is_draft,token_deal_submitted_at,ama_submitted_at,pending_request_submitted_at,final_submitted_at,cp_bill_submitted_at,listing_submitted_at,created_at
    FROM properties WHERE TRUE${vis.clause} ORDER BY created_at DESC`,vis.params);res.json(rows)}catch(e){console.error('Properties list error:',e.message);res.status(500).json({error:e.message})}
});

app.get('/api/admin/property/:uid', isAuthenticated, isAdmin, async(req,res)=>{
  try{const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
    if(!rows.length)return res.status(404).json({error:'Not found'});res.json(rows[0])}catch(e){console.error('Property detail error:',e.message);res.status(500).json({error:e.message})}
});

// Fields an admin may edit (and that get copied on replicate). Module-scoped so both handlers share it.
const ADMIN_EDITABLE=new Set(['city','locality','society_name','unit_no','tower_no','floor','area_sqft','configuration',
      'demand_price','source','owner_broker_name','first_name','last_name','contact_no','assigned_by','field_exec',
      'schedule_date','schedule_time','co_owner','co_owner_number','lead_id',
      'extra_area','bathrooms','balconies','gas_pipeline','parking','furnishing','furnishing_details',
      'total_lifts','total_floors_tower','total_flats_floor','exit_facing','video_link','visit_remarks',
      'token_requested_by','registry_status','occupancy_status','key_handover_date','owner_will_vacate',
      'guaranteed_sale_price','performance_guarantee','total_deposit','refundable_deposit',
      'initial_period','rent_payable_initial_period',
      'grace_period','rent_payable_grace_period','outstanding_loan','bank_name_loan','loan_account_number',
      'loan_pay_willingness','has_loan','loan_applicant_name','loan_co_applicant_name','token_remarks','token_remarks_printed',
      'cheque_bank_name','cheque_account_number','cheque_ifsc',
      'owner_pan_url','owner_aadhaar_front_url','owner_aadhaar_back_url','owner_property_doc_url',
      'deal_token_amount','deal_bank_name','deal_bank_account_number','deal_ifsc_code','deal_transfer_date','deal_neft_reference','owner_email','co_owner_email','third_owner_email','broker_email',
      'ama_sanction_url','ama_soa_url','ama_lod_url','ama_pg_non_forfeitable','ama_beta_max_pct','ama_beta_min_pct','ama_payment_structure',
      'ama_maint_alignment','ama_elec_alignment','ama_special_terms','ama_prop_docs','docs_verification_mode',
      'ama_date','signed_ama_url','co_owner_aadhaar_front_url','co_owner_aadhaar_back_url','co_owner_pan_url','co_owner_cheque_url',
      'remaining_amount',
      'cp_code','cp_name','cp_phone','cp_firm','cp_email','deal_type','oh_acquired_model','agreed_brokerage',
      'deal_value','total_brokerage_amount','to_be_released_now','incentive_visit','incentive_owner_meeting','total_cp_amount',
      'cp_pan_card_url','cp_aadhaar_front_url','cp_aadhaar_back_url','cp_cancelled_cheque_url','cp_ama_signed_url','cp_gst_invoice_url','cp_coi_url','gst_applicable','cp_bill_remarks',
      'super_area','carpet_area','seller_residential_status','sellers_available_on_registry',
      'listing_asking_price',
      'society_age_years','total_units','maintenance_charges','society_move_in_charges','electricity_charges',
      'water_supply','dg_charges','alpha_beta','beta_pct','loan_status','seller_location','club_facility',
      'circle_rate','parking_number','is_dead','is_token_refunded',
      'token_request_email_sent','token_deal_email_sent','pending_request_email_sent','cp_bill_email_sent','final_email_sent']);

// Admin: Update any property fields
app.post('/api/admin/property/:uid', isAuthenticated, isAdmin, async(req,res)=>{
  try{
    const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
    if(!rows.length)return res.status(404).json({error:'UID not found'});
    const oldProp=rows[0];
    const d=req.body;delete d.uid;delete d.created_at;delete d.updated_at;
    const allowed=ADMIN_EDITABLE;
    const sets=[];const vals=[];let i=1;
    const changes={};
    for(const[k,v]of Object.entries(d)){
      if(!allowed.has(k))continue;
      const newVal=v===''?null:v;
      const oldStr=oldProp[k]!=null?String(oldProp[k]):null;
      const newStr=newVal!=null?String(newVal):null;
      if(oldStr!==newStr)changes[k]={old:oldProp[k],new:newVal};
      sets.push(`${k}=$${i}`);vals.push(newVal);i++;
    }
    if(!sets.length)return res.status(400).json({error:'No valid fields to update'});
    sets.push(`updated_at=NOW()`);
    vals.push(req.params.uid);
    await pool.query(`UPDATE properties SET ${sets.join(',')} WHERE uid=$${i}`,vals);
    // Keep visit_date_history.cancelled_on in sync when a visit is cancelled / un-cancelled here
    if(changes.is_dead){
      const{setCancelled,clearCancelled}=require('./utils/visit-history');
      const nh=changes.is_dead.new?setCancelled(oldProp.visit_date_history,oldProp.schedule_date):clearCancelled(oldProp.visit_date_history);
      await pool.query('UPDATE properties SET visit_date_history=$1 WHERE uid=$2',[JSON.stringify(nh),req.params.uid]);
    }
    const{rows:updated}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
    res.json({success:true,property:updated[0]});
    // Log changes
    const logger=require('./utils/logger');
    if(Object.keys(changes).length){
      // Log status changes separately
      if(changes.is_dead)logger.logStatusChange(req.params.uid,changes.is_dead.new?'visit_cancelled':'visit_uncancelled',changes.is_dead.old,changes.is_dead.new,req.user?.email,req.user?.name).catch(()=>{});
      if(changes.is_token_refunded)logger.logStatusChange(req.params.uid,changes.is_token_refunded.new?'cancelled_post_token':'undo_cancelled_post_token',changes.is_token_refunded.old,changes.is_token_refunded.new,req.user?.email,req.user?.name).catch(()=>{});
      if(changes.assigned_by)logger.logAssignment(req.params.uid,'assigned_by_changed',changes.assigned_by.old,changes.assigned_by.new,req.user?.email,req.user?.name,'admin_edit').catch(()=>{});
      if(changes.field_exec)logger.logAssignment(req.params.uid,'assigned_to_changed',changes.field_exec.old,changes.field_exec.new,req.user?.email,req.user?.name,'admin_edit').catch(()=>{});
      // Log full admin edit
      logger.logAdminEdit(req.params.uid,changes,req.user?.email,req.user?.name).catch(()=>{});
    }
  }catch(e){console.error('Admin update error:',e.message);res.status(500).json({error:e.message})}
});

// Admin: Replicate a property into a new OH ID. Copies every ADMIN_EDITABLE field
// except source & lead_id (which come from the request). New UID keeps the source
// property's city code and uses the chosen source's code: OH{city}{C|D}{next}.
app.post('/api/admin/property/:uid/replicate', isAuthenticated, isAdmin, async(req,res)=>{
  try{
    const SRC_MAP={CP:'C',Direct:'D'};
    const source=req.body&&req.body.source;
    if(!SRC_MAP[source])return res.status(400).json({error:'source must be CP or Direct'});
    const lead_id=req.body&&req.body.lead_id!=null?String(req.body.lead_id).trim()||null:null;
    const{rows}=await pool.query('SELECT * FROM properties WHERE uid=$1',[req.params.uid]);
    if(!rows.length)return res.status(404).json({error:'UID not found'});
    const src=rows[0];
    // Reuse the source UID's city code (everything between OH and the trailing source char + digits).
    const m=String(src.uid||'').match(/^OH([A-Z]+)([A-Z])(\d+)$/);
    if(!m)return res.status(400).json({error:'Cannot parse OH ID prefix from '+src.uid});
    const prefix=`OH${m[1]}${SRC_MAP[source]}`;
    const{rows:mx}=await pool.query(`SELECT MAX(CAST(REPLACE(uid,$1,'') AS INTEGER)) AS max_num FROM properties WHERE uid LIKE $2`,[prefix,prefix+'%']);
    const newUid=prefix+String((mx[0].max_num||1000)+1);
    const cols=['uid','source','lead_id'];const vals=[newUid,source,lead_id];
    for(const k of ADMIN_EDITABLE){
      if(k==='source'||k==='lead_id')continue;
      let v=src[k];
      // JSONB columns come back as JS objects/arrays — stringify so pg stores valid JSON, not an array literal.
      if(v!==null&&typeof v==='object'&&!(v instanceof Date))v=JSON.stringify(v);
      cols.push(k);vals.push(v);
    }
    await pool.query(`INSERT INTO properties(${cols.join(',')}) VALUES(${cols.map((_,idx)=>'$'+(idx+1)).join(',')})`,vals);
    res.json({success:true,uid:newUid});
    require('./utils/logger').log(newUid,'replicate','admin',req.user?.email,req.user?.name,{source_uid:src.uid,source,lead_id}).catch(()=>{});
  }catch(e){console.error('Replicate error:',e.message);res.status(500).json({error:e.message})}
});

// ── My Properties — user sees only their linked properties ──
app.get('/api/my-properties', isAuthenticated, async(req,res)=>{
  try{const vis=visibilityFilter(req.user);
    const baseWhere=vis.clause?`WHERE TRUE${vis.clause}`:'';
    const{rows}=await pool.query(`SELECT uid,city,locality,society_name,unit_no,tower_no,floor,area_sqft,configuration,
      demand_price,source,owner_broker_name,contact_no,assigned_by,field_exec,
      schedule_date,schedule_time,is_dead,is_token_refunded,
      schedule_submitted_at,visit_submitted_at,token_submitted_at,token_is_draft,
      token_deal_submitted_at,ama_submitted_at,pending_request_submitted_at,final_submitted_at,cp_bill_submitted_at,listing_submitted_at
      FROM properties ${baseWhere} ORDER BY created_at DESC`,vis.params);
    res.json(rows)}catch(e){console.error('MyProps error:',e.message);res.status(500).json({error:e.message})}
});

// Diagnostic: test whether the logged-in user's Google token can write to Calendar.
// Visit /api/calendar/diag in the browser while logged in — returns the real Google error.
app.get('/api/calendar/diag', isAuthenticated, async(req,res)=>{
  try{
    // Admins/super can test another user's token via ?email=; everyone else tests their own.
    let targetEmail=req.user.email;
    if(req.query.email&&(req.user.is_super||req.user.is_admin))targetEmail=String(req.query.email).toLowerCase();
    const{rows}=await pool.query('SELECT email,google_access_token,google_refresh_token FROM users WHERE LOWER(email)=LOWER($1)',[targetEmail]);
    const u=rows[0]||{};
    const info={testedUser:targetEmail,found:!!rows.length,hasAccessToken:!!u.google_access_token,hasRefreshToken:!!u.google_refresh_token,appUrlSet:!!process.env.APP_URL};
    if(!rows.length)return res.json({ok:false,...info,error:'No such active user.'});
    if(!u.google_access_token&&!u.google_refresh_token)return res.json({ok:false,...info,error:'No Google token stored for this user — they must log out and log in again.'});
    const{diagnoseCalendar}=require('./utils/calendar');
    const id=await diagnoseCalendar({accessToken:u.google_access_token,refreshToken:u.google_refresh_token});
    res.json({ok:true,...info,testEventId:id,message:'Calendar insert+delete succeeded — calendar works for this user.'});
  }catch(e){
    res.json({ok:false,error:e.message,code:e.code||null,details:(e.errors||e.response?.data?.error||null)});
  }
});

const sendForm = (f) => [isAuthenticated, hasFormAccess, (_, r) => r.sendFile(path.join(__dirname, 'public', f))];
app.get('/schedule', ...sendForm('schedule.html'));
app.get('/visit', ...sendForm('visit.html'));
app.get('/token-request', ...sendForm('token-request.html'));
app.get('/token-deal', ...sendForm('token-deal.html'));
app.get('/ama-details', ...sendForm('ama-details.html'));
app.get('/pending-request', ...sendForm('pending-request.html'));
app.get('/final', ...sendForm('final.html'));
app.get('/listing', ...sendForm('listing.html'));
app.get('/cp-bill', ...sendForm('cp-bill.html'));
app.get('/admin', isAuthenticated, hasAdminPanelAccess, (_, r) => r.sendFile(path.join(__dirname, 'public/admin.html')));
app.get('/my-properties', isAuthenticated, (_, r) => r.sendFile(path.join(__dirname, 'public/my-properties.html')));
app.get('/', isAuthenticated, (_, r) => r.sendFile(path.join(__dirname, 'public/index.html')));

async function start() {
  try {
    await pool.query(MIGRATION_SQL); console.log('Migration done');
    await pool.query(COMPAT_SQL); console.log('Compat done, DB ready');
    await pool.query(LOGS_TABLE_SQL); console.log('Logs table ready');
    require('./utils/whatsapp').init(pool);
    require('./utils/email-sender').init(pool);
    require('./utils/logger').init(pool);
    // Auto-seed user phone/roles if not yet populated
    const needSeed=await pool.query(`SELECT COUNT(*) as c FROM users WHERE phone IS NOT NULL AND phone!=''`);
    if(parseInt(needSeed.rows[0].c)===0){
      console.log('Seeding user phones & roles...');
      const SEED={
        'rahool@openhouse.in':{phone:'9899546824',is_top_manager:true},
        'ashish@openhouse.in':{phone:'9555666059',is_top_manager:true},
        'prashant@openhouse.in':{phone:'9289500953',is_top_manager:true},
        'abhishek.rathore@openhouse.in':{phone:'9452441498',can_assign:true},
        'aman.dixit@openhouse.in':{phone:'9266533475',can_assign:true,can_visit:true},
        'animesh.singh@openhouse.in':{phone:'9810826481',can_assign:true,can_visit:true},
        'arti.ahirwar@openhouse.in':{phone:'9289500948',can_assign:true},
        'deepak.mishra@openhouse.in':{phone:'8130724002',can_assign:true,can_visit:true},
        'deepak.rana@openhouse.in':{phone:'7428500192',can_assign:true,can_visit:true},
        'kavita.rawat@openhouse.in':{phone:'9311338216',can_assign:true},
        'nisha.deewan@openhouse.in':{phone:'9211599292',can_assign:true},
        'rahul.sheel@openhouse.in':{phone:'9289311664',can_assign:true,can_visit:true},
        'rupali.prasad@openhouse.in':{phone:'9289996738',can_assign:true},
        'sahil.singh@openhouse.in':{phone:'9217275007',can_assign:true,can_visit:true},
        'shashank.kumar@openhouse.in':{phone:'9205658886',can_assign:true},
        'sushmita.roy@openhouse.in':{phone:'9821700377',can_assign:true},
        'ashwani.sharma@openhouse.in':{phone:'9217710686',can_visit:true},
        'manish.sharma@openhouse.in':{phone:'7428500816',can_visit:true},
        'nishant.kumar@openhouse.in':{phone:'8130733966',can_visit:true},
        'praveen.kumar@openhouse.in':{phone:'9289996737',can_visit:true},
        'rahul.singh@openhouse.in':{phone:'9217710683',can_visit:true},
        'saurabh@openhouse.in':{phone:'9174286625'},
        'sahaj.dureja@openhouse.in':{phone:'8003297088'},
        'saransh.khera@openhouse.in':{phone:'8595594789'},
        'akash.teotia@openhouse.in':{phone:'9311338205'},
      };
      for(const[email,d]of Object.entries(SEED)){
        try{await pool.query(`UPDATE users SET phone=COALESCE(NULLIF($1,''),phone),can_assign=COALESCE($2,can_assign),can_visit=COALESCE($3,can_visit),is_top_manager=COALESCE($4,is_top_manager) WHERE LOWER(email)=LOWER($5)`,
          [d.phone||null,d.can_assign||false,d.can_visit||false,d.is_top_manager||false,email]);
        }catch(e){console.error(`Seed ${email}:`,e.message)}
      }
      console.log('User roles seeded');
    }
    const { rows } = await pool.query('SELECT COUNT(*)as c FROM master_societies');
    if (parseInt(rows[0].c) === 0) { for (const [c, l, s] of SOCIETIES) await pool.query('INSERT INTO master_societies(city,locality,society_name)VALUES($1,$2,$3)ON CONFLICT DO NOTHING', [c, l, s]); console.log(`Seeded ${SOCIETIES.length} societies`); }
    const uc = await pool.query('SELECT COUNT(*)as c FROM users');
    if (parseInt(uc.rows[0].c) === 0) { console.log('\n  ⚠  No users found. Add first admin via Render Shell.'); }
    app.listen(PORT, () => console.log(`\n  OPENHOUSE v6.3 — Dead+Visibility — Port ${PORT}\n`));
  } catch (e) { console.error('Startup failed:', e.message); process.exit(1); }
}
start();