// Total Deposit Invoice (Form 6)

function fmtDate(d){if(!d)return '—';const dt=new Date(d);const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return `${String(dt.getDate()).padStart(2,'0')} ${m[dt.getMonth()]} ${dt.getFullYear()}`}
function fmtCur(v){if(!v)return '—';const n=Number(v);if(n>=10000000)return '₹ '+(n/10000000).toFixed(2)+' Crores';return '₹ '+n.toLocaleString('en-IN')}
function esc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):''}

function generateInvoiceHTML(p, baseUrl=''){
  const today=fmtDate(new Date());
  const ownerName=p.owner_broker_name||[p.first_name,p.last_name].filter(Boolean).join(' ')||'—';
  const tokenAmt=Number(p.deal_token_amount||0);
  const remainAmt=Number(p.remaining_amount||0);
  const total=tokenAmt+remainAmt;
  const logoUrl=baseUrl?baseUrl+'/images/logo.png':'/images/logo.png';

  const dealAc=p.deal_bank_account_number||p.cheque_account_number||'—';
  const finalAc=dealAc;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Total Deposit – ${esc(p.uid)}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--ink:#1a1510;--muted:#7a6f63;--border:#ddd6cc;--bg:#faf8f5;--cream:#f4f0ea;--gold:#b8985a;--green:#2d5a3d;--green-light:#e8f2ec;--white:#fff}
  body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--ink);padding:24px 20px 40px;font-size:12px}
  .page{max-width:680px;margin:0 auto}
  .print-bar{text-align:center;margin-bottom:16px}
  .print-bar button{font-family:'DM Sans',sans-serif;padding:8px 24px;border:1.5px solid var(--border);border-radius:8px;background:var(--white);cursor:pointer;font-size:12px;font-weight:500}
  .inv-header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;margin-bottom:14px;border-bottom:2px solid var(--ink)}
  .inv-brand{display:flex;align-items:center;gap:10px}
  .inv-co{font-size:22px;font-weight:600}
  .inv-addr{font-size:10px;color:var(--muted);margin-top:3px;line-height:1.5;max-width:300px}
  .inv-title-block{text-align:right}
  .inv-title{font-size:24px;font-weight:700;color:var(--ink);letter-spacing:.02em}
  .owner-section{margin:14px 0;padding:14px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
  .owner-label{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:500;margin-bottom:6px}
  .owner-name{font-size:14px;font-weight:600;margin-bottom:2px}
  .owner-detail{font-size:11px;color:var(--muted);line-height:1.6}
  .inv-table{width:100%;border-collapse:collapse;margin:14px 0}
  .inv-table thead{background:var(--ink)}
  .inv-table th{color:var(--white);font-size:9px;letter-spacing:.1em;text-transform:uppercase;font-weight:500;padding:10px 12px;text-align:left}
  .inv-table th:last-child{text-align:right}
  .inv-table td{padding:10px 12px;font-size:12px;border-bottom:1px solid var(--border);vertical-align:top}
  .inv-table td:last-child{text-align:right;font-weight:600;font-size:14px}
  .inv-table tr:nth-child(even){background:#faf8f5}
  .inv-table .mono{font-family:monospace;font-size:10px;color:var(--muted)}
  .inv-totals{display:flex;justify-content:flex-end;margin-top:6px}
  .inv-totals-box{width:280px}
  .inv-totals-row{display:flex;justify-content:space-between;padding:6px 0;font-size:12px}
  .inv-totals-row.total{border-top:2px solid var(--ink);padding-top:10px;margin-top:6px}
  .inv-totals-row.total .tl{font-size:13px;font-weight:700}
  .inv-totals-row.total .tv{font-size:18px;font-weight:700}
  .tl{color:var(--muted);font-weight:500}.tv{font-weight:600}
  .inv-status{display:inline-block;padding:3px 12px;border-radius:20px;font-size:10px;font-weight:600;background:var(--green-light);color:var(--green)}
  @media print{body{background:white;padding:12px 16px 20px}.page{max-width:100%}.print-bar{display:none!important}
    .inv-table thead,.inv-status{-webkit-print-color-adjust:exact;print-color-adjust:exact}@page{margin:.5cm .8cm;size:A4}}
</style></head>
<body><div class="page">
  <div class="print-bar"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="inv-header">
    <div>
      <div class="inv-brand"><img src="${logoUrl}" alt="Openhouse" style="height:40px"><span class="inv-co"></span></div>
      <div class="inv-addr">Avano Technologies Private Limited<br>VentureX, Unit No. 202 &amp; 202A, Silverton Tower,<br>Sector 50, Golf Course Extension Road, Gurugram 122018</div>
    </div>
    <div class="inv-title-block"><div class="inv-title">TOTAL<br>DEPOSIT</div></div>
  </div>
  <div class="owner-section">
    <div class="owner-label">Owner Details</div>
    <div class="owner-name">${esc(ownerName)}</div>
    <div class="owner-detail">
      ${esc(p.contact_no||'')}<br>
      ${esc(p.unit_no||'')}${p.tower_no?', Tower '+esc(p.tower_no):''}, ${esc(p.society_name||'')}
    </div>
  </div>
  <table class="inv-table">
    <thead><tr><th>Description</th><th>NEFT Reference</th><th>Transfer Date</th><th>Amount</th></tr></thead>
    <tbody>
      <tr>
        <td><strong>Token Amount</strong><br><span class="mono">via A/C ${esc(dealAc)}</span></td>
        <td><span class="mono">${esc(p.deal_neft_reference||'—')}</span></td>
        <td>${fmtDate(p.deal_transfer_date)}</td>
        <td>${fmtCur(p.deal_token_amount)}</td>
      </tr>
      <tr>
        <td><strong>Remaining Amount</strong><br><span class="mono">via A/C ${esc(finalAc)}</span></td>
        <td><span class="mono">—</span></td>
        <td>${fmtDate(p.deal_transfer_date)}</td>
        <td>${fmtCur(p.remaining_amount)}</td>
      </tr>
    </tbody>
  </table>
  <div class="inv-totals">
    <div class="inv-totals-box">
      <div class="inv-totals-row"><span class="tl">Token Amount</span><span class="tv">${fmtCur(p.deal_token_amount)}</span></div>
      <div class="inv-totals-row"><span class="tl">Remaining Amount</span><span class="tv">${fmtCur(p.remaining_amount)}</span></div>
      <div class="inv-totals-row total"><span class="tl">Total Amount Paid</span><span class="tv">${fmtCur(total)}</span></div>
    </div>
  </div>
  <div style="text-align:center;margin-top:16px">
    <span class="inv-status">PAID — Both payments received</span>
  </div>
</div></body></html>`;
}

module.exports = { generateInvoiceHTML };