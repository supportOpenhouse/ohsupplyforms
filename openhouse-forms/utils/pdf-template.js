// Deal Terms PDF (Form 4) - HTML template

function fmtDate(d){if(!d)return '—';const dt=new Date(d);const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return `${String(dt.getDate()).padStart(2,'0')} ${m[dt.getMonth()]} ${dt.getFullYear()}`}
function fmtAmt(v){if(!v||isNaN(v))return '—';const n=Number(v);if(n>=10000000)return '₹ '+parseFloat((n/10000000).toFixed(4))+' Crores';if(n>=100000)return '₹ '+parseFloat((n/100000).toFixed(4))+' Lakhs';return '₹ '+n.toLocaleString('en-IN')}
function fmtPG(v){if(!v||isNaN(v))return '—';const n=Number(v);if(n>=10000000){const x=Math.floor(n/10000)/1000;return '₹ '+parseFloat(x.toFixed(3))+' Crores'}if(n>=100000){const x=Math.floor(n/100)/1000;return '₹ '+parseFloat(x.toFixed(3))+' Lakhs'}return '₹ '+n.toLocaleString('en-IN')}
function fmtCurrency(v){if(!v||isNaN(v))return '—';return '₹ '+Number(v).toLocaleString('en-IN')}
function fmtLakhs(v){if(!v)return '—';const n=Number(v);if(n>=100)return '₹ '+parseFloat((n/100).toFixed(4))+' Crores';return '₹ '+parseFloat(n.toFixed(4))+' Lakhs'}
function esc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}
function pill(val,type){return val?`<span class="pill ${type}">${esc(val)}</span>`:'—'}
function fval(v,cls=''){if(!v||v==='null')return `<div class="f-value empty">—</div>`;return `<div class="f-value ${cls}">${esc(String(v))}</div>`}

// Robust document parser — handles string, array, double-encoded, leading spaces
function parseDocs(raw){
  if(!raw) return [];
  if(Array.isArray(raw)) return raw.map(s=>typeof s==='string'?s.trim():s);
  if(typeof raw==='string'){
    try{
      const parsed=JSON.parse(raw);
      if(Array.isArray(parsed)) return parsed.map(s=>typeof s==='string'?s.trim():s);
      if(typeof parsed==='string'){try{const p2=JSON.parse(parsed);return Array.isArray(p2)?p2.map(s=>typeof s==='string'?s.trim():s):[]}catch(e2){}}
      return [];
    }catch(e){return []}
  }
  return [];
}

function generateReceiptHTML(p, mode='deal', baseUrl=''){
  const today=fmtDate(new Date());
  const rawOwner=p.owner_broker_name||[p.first_name,p.last_name].filter(Boolean).join(' ')||'—';
  const ownerName=p.co_owner?rawOwner+' & '+p.co_owner:rawOwner;
  const firstName=p.first_name||rawOwner.split(' ')[0]||'Owner';
  const logoUrl=baseUrl?baseUrl+'/images/logo.png':'/images/logo.png';

  const allDocs=['Allotment Letter issued by the Builder','Possession Letter/Certificate by the Builder','Builder Buyer Agreement','Conveyance Deed/Sub Lease Deed/Sale Deed'];
  const selectedDocs=parseDocs(p.documents_available);
  console.log('PDF docs raw type:', typeof p.documents_available, '| parsed:', JSON.stringify(selectedDocs));
  const missingDocs=allDocs.filter(d=>!selectedDocs.includes(d));
  const availDocs=allDocs.filter(d=>selectedDocs.includes(d));
  console.log('PDF avail:', availDocs.length, 'missing:', missingDocs.length);

  const hasNEFT=!!p.deal_neft_reference;
  const neftBank=p.deal_bank_name||'';
  const neftRef=p.deal_neft_reference||'';
  const neftDate=p.deal_transfer_date;
  const hdDate=p.key_handover_date?fmtDate(p.key_handover_date):'';
  const showRefundable = p.refundable_deposit && Number(p.refundable_deposit) !== 0;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>– ${esc(p.uid)}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--ink:#1a1510;--muted:#7a6f63;--border:#ddd6cc;--bg:#faf8f5;--cream:#f4f0ea;--gold:#b8985a;--gold-light:#e8d9b5;--green:#2d5a3d;--green-light:#e8f2ec;--white:#fff;--red-light:#fdecea;--red:#b33a2e}
  body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--ink);padding:12px 16px 16px;font-size:11.5px}
  .page{max-width:680px;margin:0 auto}
  .header{display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;margin-bottom:8px;border-bottom:1.5px solid var(--border)}
  .brand{display:flex;align-items:center;gap:8px}
  .brand-name{font-size:20px;font-weight:600;letter-spacing:.04em}
  .header-right{text-align:right}
  .receipt-tag{font-size:9.5px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
  .receipt-date{font-size:10.5px;color:var(--muted);margin-top:2px}
  .greeting-strip{background:var(--ink);border-radius:8px;padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .greeting-left .hi{font-size:19px;font-weight:400;color:var(--white)}
  .greeting-left .sub{font-size:10.5px;color:rgba(255,255,255,.6);margin-top:3px;font-weight:300}
  .price-block{text-align:right}
  .price-label{font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--gold-light);opacity:.7;margin-bottom:2px}
  .price-val{font-size:24px;font-weight:600;color:var(--white);line-height:1}
  .deposit-grid{display:grid;gap:6px;margin-bottom:8px}
  .deposit-grid.cols-3{grid-template-columns:1fr 1fr 1fr}
  .deposit-grid.cols-2{grid-template-columns:1fr 1fr}
  .deposit-card{background:var(--white);border:1px solid var(--border);border-radius:6px;padding:8px 10px;text-align:left}
  .deposit-card .d-label{font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:2px;font-weight:500}
  .deposit-card .d-val{font-size:14px;font-weight:600;color:var(--ink)}
  .section-label{font-size:8.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:500;margin:10px 0 4px;display:flex;align-items:center;gap:8px}
  .section-label::after{content:'';flex:1;height:1px;background:var(--border)}
  .field-grid{display:grid;gap:4px}.field-grid.col2{grid-template-columns:1fr 1fr}.field-grid.col3{grid-template-columns:1fr 1fr 1fr}.field-grid.col4{grid-template-columns:1fr 1fr 1fr 1fr}
  .field{background:var(--white);border:1px solid var(--border);border-radius:5px;padding:6px 10px}
  .field .f-label{font-size:8px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:500;margin-bottom:3px}
  .field .f-value{font-size:11.5px;font-weight:500;color:var(--ink);line-height:1.2}
  .field .f-value.mono{font-family:monospace;font-size:10.5px;letter-spacing:.04em}
  .field .f-value.empty{color:#bbb;font-weight:300;font-size:10.5px;font-style:italic}
  .pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:9.5px;font-weight:500}
  .pill.green{background:var(--green-light);color:var(--green)}.pill.gold{background:#fef8ec;color:#8a6a1a}.pill.red{background:var(--red-light);color:var(--red)}
  .token-strip{background:var(--green-light);border:1.5px solid #b8d9c4;border-radius:7px;padding:8px 12px;display:flex;align-items:center;gap:10px}
  .token-icon{width:28px;height:28px;background:var(--green);border-radius:50%;display:grid;place-items:center;flex-shrink:0}
  .token-icon svg{width:14px;height:14px;stroke:white;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
  .token-info{flex:1}.token-info .t-title{font-size:11.5px;font-weight:500;color:var(--green)}
  .token-info .t-ref{font-size:10.5px;color:#4a7a5d;font-family:monospace;margin-top:2px}
  .token-date{text-align:right;flex-shrink:0}
  .token-date .td-label{font-size:8px;text-transform:uppercase;letter-spacing:.09em;color:#4a7a5d}
  .token-date .td-val{font-size:13px;font-weight:600;color:var(--green);margin-top:2px}
  .doc-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}
  .doc-item{background:var(--white);border:1px solid var(--border);border-radius:5px;padding:6px 10px;display:flex;align-items:center;gap:8px;font-size:11px}
  .doc-item.missing{border-color:#f0c4c0;background:var(--red-light);color:var(--red)}
  .doc-box{width:12px;height:12px;border:1.5px solid var(--border);border-radius:2px;background:var(--cream);flex-shrink:0}
  .doc-box.checked{background:var(--green);border-color:var(--green)}
  .terms-wrap{background:var(--cream);border:1px solid var(--border);border-radius:8px;padding:16px 20px}
  .terms-wrap h4{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:500;margin-bottom:12px}
  .terms-list{list-style:none;display:flex;flex-direction:column;gap:10px}
  .terms-list li{display:flex;gap:10px;font-size:12px;color:#4a4035;line-height:1.6;font-weight:300}
  .terms-list li::before{content:'—';color:var(--gold);flex-shrink:0}
  .footer{margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
  .footer-brand{font-size:12px;font-weight:600;margin-bottom:3px}
  .footer-cin{font-size:9.5px;color:var(--muted);font-weight:300;line-height:1.6}
  .footer-note{font-size:8.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.09em;text-align:right;line-height:1.7;flex-shrink:0}
  .print-bar{text-align:center;margin-bottom:12px}
  .print-bar button{font-family:'DM Sans',sans-serif;padding:8px 24px;border:1.5px solid var(--border);border-radius:8px;background:var(--white);cursor:pointer;font-size:12px;font-weight:500}
  
  /* Layout constraints for full-page structure */
  .page-1-content, .page-2-content {display:flex;flex-direction:column;min-height:calc(100vh - 40px)}
  .page-1-content .p1-body, .page-2-content .p2-body {flex:1}
  .page-1-content > .footer, .page-2-content > .footer {margin-top:auto}
  .page-1-content .section-label,.page-1-content .field-grid,.page-1-content .doc-grid,.page-1-content .token-strip{page-break-inside:avoid}
  
  @media print{body{background:white;padding:12px 16px 16px}.page{max-width:100%}.print-bar{display:none!important}
    .page-1-content, .page-2-content {min-height:calc(100vh - 28px)}
    .field,.doc-item,.terms-wrap,.token-strip,.greeting-strip,.deposit-card{-webkit-print-color-adjust:exact;print-color-adjust:exact}@page{margin:.4cm .6cm;size:A4}}
</style></head>
<body><div class="page">
  <div class="print-bar"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="page-1-content">
  <div class="p1-body">
  <div class="header">
    <div class="brand"><img src="${logoUrl}" alt="Openhouse" style="height:36px"><span class="brand-name"></span></div>
    <div class="header-right"><div class="receipt-tag"></div><div class="receipt-date">Generated: ${today}</div></div>
  </div>
  <div class="greeting-strip">
    <div class="greeting-left"><div class="hi">Hello, <strong>${esc(firstName)}</strong></div><div class="sub">Here are the agreed deal terms for your property.</div></div>
    ${p.guaranteed_sale_price?`<div class="price-block"><div class="price-label">Guaranteed Sale Price</div><div class="price-val">${fmtLakhs(p.guaranteed_sale_price)}</div></div>`:''}
  </div>

  <div class="deposit-grid ${showRefundable ? 'cols-3' : 'cols-2'}">
    <div class="deposit-card"><div class="d-label">Total Deposit (₹)</div><div class="d-val">${fmtCurrency(p.total_deposit)}</div></div>
    <div class="deposit-card"><div class="d-label">Performance Guarantee (₹)</div><div class="d-val">${fmtCurrency(p.performance_guarantee)}</div></div>
    ${showRefundable ? `<div class="deposit-card"><div class="d-label">Refundable Deposit (₹)</div><div class="d-val">${fmtCurrency(p.refundable_deposit)}</div></div>` : ''}
  </div>

  <div class="section-label">Seller Details</div>
  <div class="field-grid col2">
    <div class="field"><div class="f-label">Owner Name</div><div class="f-value">${esc(ownerName)}</div></div>
    <div class="field"><div class="f-label">Contact</div>${fval(p.contact_no,'mono')}</div>
  </div>
  <div class="section-label">Property Details</div>
  <div class="field-grid col4">
    <div class="field"><div class="f-label">City</div>${fval(p.city)}</div>
    <div class="field"><div class="f-label">Society</div>${fval(p.society_name)}</div>
    <div class="field"><div class="f-label">Tower</div>${fval(p.tower_no)}</div>
    <div class="field"><div class="f-label">Unit</div>${fval(p.unit_no)}</div>
  </div>
  <div class="field-grid col3" style="margin-top:4px">
    <div class="field"><div class="f-label">Config</div>${fval(p.configuration)}</div>
    <div class="field"><div class="f-label">Floor</div>${fval(p.floor)}</div>
    <div class="field"><div class="f-label">Area (sqft)</div>${fval(p.area_sqft?Number(p.area_sqft).toLocaleString('en-IN'):null)}</div>
  </div>
  <div class="field-grid col2" style="margin-top:4px">
    <div class="field"><div class="f-label">Registry Status</div><div class="f-value">${p.registry_status?pill(p.registry_status,p.registry_status==='Registered'?'green':'gold'):'—'}</div></div>
    <div class="field"><div class="f-label">Occupancy Status</div><div class="f-value">${p.occupancy_status?pill(p.occupancy_status,p.occupancy_status==='Vacant'?'gold':p.occupancy_status==='Tenant'?'red':'green'):'—'}</div></div>
  </div>
  ${hdDate?`<div class="field-grid col2" style="margin-top:4px"><div class="field"><div class="f-label">Key Handover Date</div><div class="f-value">${hdDate}</div></div><div class="field"></div></div>`:''}
  <div class="section-label">Deal Terms</div>
  <div class="field-grid col2">
    <div class="field"><div class="f-label">Token Amount</div><div class="f-value">${fmtAmt(p.deal_token_amount)}</div></div>
    <div class="field"><div class="f-label">Guaranteed Sale Price</div><div class="f-value">${p.guaranteed_sale_price?fmtLakhs(p.guaranteed_sale_price):'—'}</div></div>
  </div>
  ${(p.initial_period||p.grace_period)?`<div class="field-grid col2" style="margin-top:4px">
    ${p.initial_period&&p.rent_payable_initial_period&&p.rent_payable_initial_period!=='N/A'?`<div class="field"><div class="f-label">Initial Period</div><div class="f-value">${p.initial_period} days → ${fmtCurrency(p.rent_payable_initial_period)}/mo</div></div>`
      :p.initial_period?`<div class="field"><div class="f-label">Initial Period</div><div class="f-value">${p.initial_period} days</div></div>`:'<div></div>'}
    ${p.grace_period&&p.rent_payable_grace_period&&p.rent_payable_grace_period!=='N/A'?`<div class="field"><div class="f-label">Grace Period</div><div class="f-value">${p.grace_period} days → ${fmtCurrency(p.rent_payable_grace_period)}/mo</div></div>`
      :p.grace_period?`<div class="field"><div class="f-label">Grace Period</div><div class="f-value">${p.grace_period} days</div></div>`:'<div></div>'}
  </div>`:''}
  ${p.has_loan!=='No'&&(p.outstanding_loan||p.bank_name_loan||p.loan_pay_willingness)?`<div class="section-label">Loan Details</div>
  <div class="field-grid col3">
    <div class="field"><div class="f-label">Outstanding Loan</div>${fval(p.outstanding_loan?fmtCurrency(p.outstanding_loan):null)}</div>
    <div class="field"><div class="f-label">Bank (Loan)</div>${fval(p.bank_name_loan)}</div>
    <div class="field"><div class="f-label">Seller to Pay?</div><div class="f-value">${p.loan_pay_willingness?pill(p.loan_pay_willingness,p.loan_pay_willingness==='Yes'?'green':'red'):'—'}</div></div>
  </div>`:''}
  ${availDocs.length?`<div class="section-label">Documents Available</div>
  <div class="doc-grid">
    ${availDocs.map(d=>`<div class="doc-item"><div class="doc-box checked"></div>${esc(d.replace('issued by the Builder','').replace('/Certificate by the Builder','').replace('Conveyance Deed/Sale Deed/Registry','Conveyance Deed').trim())}</div>`).join('\n    ')}
  </div>`:''}
  ${missingDocs.length?`<div class="section-label">Documents Missing</div>
  <div class="doc-grid">${missingDocs.map(d=>`<div class="doc-item missing"><div class="doc-box"></div>${esc(d.replace('issued by the Builder','').replace('/Certificate by the Builder','').replace('Conveyance Deed/Sale Deed/Registry','Conveyance Deed').trim())}</div>`).join('\n    ')}</div>`:''}
  ${(p.cheque_bank_name||p.cheque_account_number||p.cheque_ifsc||neftBank||p.deal_bank_account_number||p.deal_ifsc_code)?`<div class="section-label">Seller Bank Details</div>
  <div class="field-grid col3">
    <div class="field"><div class="f-label">Bank Name</div>${fval(p.cheque_bank_name||neftBank)}</div>
    <div class="field"><div class="f-label">Account Number</div>${fval(p.cheque_account_number||p.deal_bank_account_number,'mono')}</div>
    <div class="field"><div class="f-label">IFSC Code</div>${fval(p.cheque_ifsc||p.deal_ifsc_code,'mono')}</div>
  </div>`:''}
  ${hasNEFT?`<div class="section-label">Token Transaction</div>
  <div class="token-strip">
    <div class="token-icon"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
    <div class="token-info"><div class="t-title">Token Paid — ${esc(neftBank||'Bank')}</div><div class="t-ref">NEFT Ref: ${esc(neftRef)}</div></div>
    <div class="token-date"><div class="td-label">Transfer Date</div><div class="td-val">${fmtDate(neftDate)}</div></div>
  </div>`:''}
  </div><div class="footer">
    <div><div class="footer-brand">Avano Technologies Private Limited</div>
      <div class="footer-cin">CIN: U68200HR2024PTC123116 | VentureX, Unit No. 202 &amp; 202A, Silverton Tower, Sector 50, Golf Course Extension Road, Gurugram 122018</div></div>
    <div class="footer-note"><br><a href="https://www.openhouse.in" style="color:var(--muted);text-decoration:none">www.openhouse.in</a></div>
  </div>
  </div><div class="page-2-content" style="page-break-before:always">
    <div class="p2-body">
      <div class="section-label">Terms &amp; Conditions</div>
      <div class="terms-wrap"><h4>Please read carefully</h4>
        <ul class="terms-list">
          <li>Should any discrepancies or unavailability of required documents arise during the document verification process, Openhouse reserves the right to withhold execution of the agreement. In such an event, the advance token paid will be refunded to Openhouse in full.</li>
          <li>All charges related to the Society NOC shall be the sole responsibility of the seller and must be settled at the time of ownership transfer.</li>
          <li>If the owner decides to cancel the deal after receipt of token, the owner needs to refund the token in the company’s bank account within 03 (three) calendar days, failing which there will be a penalty charged ₹1000 per day of delay beyond 03 days from the date of intimation of such cancellation.</li>
          <li>To facilitate maximum visits to your property, Openhouse will install a smart lock on your property for digital access at no cost to you.</li>
          <li>Openhouse is committed to facilitating a seamless, transparent, and mutually beneficial transaction.</li>        
          </ul>
      </div>
    </div>
    <div class="footer">
      <div><div class="footer-brand">Avano Technologies Private Limited</div>
        <div class="footer-cin">CIN: U68200HR2024PTC123116 | VentureX, Unit No. 202 &amp; 202A, Silverton Tower, Sector 50, Golf Course Extension Road, Gurugram 122018</div></div>
      <div class="footer-note"><br><a href="https://www.openhouse.in" style="color:var(--muted);text-decoration:none">www.openhouse.in</a></div>
    </div>
  </div></div></body></html>`;
}

module.exports = { generateReceiptHTML };