// Gmail API email sender with Puppeteer PDF generation
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const logger = require('./logger');
const { sendWithThreadFallback, READ_OPTS } = require('./gmail-send');

// Two transport-level fixes applied to ALL googleapis calls (Gmail + Calendar share
// this singleton):
//   1. Accept-Encoding: identity — gaxios/node-fetch has a gzip-decompression bug
//      (ERR_STREAM_PREMATURE_CLOSE → "Invalid response body … Premature close") that
//      broke every Gmail send. Requesting uncompressed responses avoids the Gunzip path.
//   2. retry off (noResponseRetries: 0) — gaxios was auto-RESENDING the non-idempotent
//      send POST on the premature-close "no response", causing duplicate emails. The
//      dedup-aware retry in ./gmail-send is the only retry path now.
google.options({ headers: { 'Accept-Encoding': 'identity' }, retry: false, retryConfig: { retry: 0, noResponseRetries: 0 } });

let _pool = null;
function init(pool) { _pool = pool; }

// Add managers to CC if any of their team members are in TO, CC, or is the sender
async function addManagerEmails(toStr, ccStr, fromEmail) {
  if (!_pool) return ccStr;
  try {
    // Collect all recipient emails + sender
    const allEmails = [...(toStr||'').split(','), ...(ccStr||'').split(','), fromEmail||'']
      .map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!allEmails.length) return ccStr;

    // Find names of all recipients
    const { rows: recipientRows } = await _pool.query(
      `SELECT name FROM users WHERE LOWER(email) = ANY($1) AND is_active=TRUE`,
      [allEmails]
    );
    const recipientNames = recipientRows.map(r => r.name?.toLowerCase()).filter(Boolean);
    if (!recipientNames.length) return ccStr;

    // Find managers whose team includes any recipient
    const { rows: mgrRows } = await _pool.query(
      `SELECT email, name, managed_team FROM users WHERE is_manager=TRUE AND is_active=TRUE AND managed_team IS NOT NULL`
    );

    const mgrEmails = [];
    for (const mgr of mgrRows) {
      const team = typeof mgr.managed_team === 'string' ? JSON.parse(mgr.managed_team || '[]') : mgr.managed_team || [];
      const teamLower = team.map(t => t.toLowerCase());
      const hasTeamMember = recipientNames.some(n => teamLower.includes(n));
      if (hasTeamMember && mgr.email && !allEmails.includes(mgr.email.toLowerCase())) {
        mgrEmails.push(mgr.email);
      }
    }

    if (!mgrEmails.length) return ccStr;
    console.log(`Manager CC added: ${mgrEmails.join(', ')}`);
    const existing = (ccStr || '').split(',').map(e => e.trim()).filter(Boolean);
    return [...existing, ...mgrEmails].join(', ');
  } catch (e) { console.error('addManagerEmails error:', e.message); return ccStr; }
}

// Add the property's Assigned By + Token By staff to CC by resolving their
// names (stored on the property) to emails via the users table.
async function addStaffEmails(toStr, ccStr, property) {
  if (!_pool) return ccStr;
  try {
    const names = [property?.assigned_by, property?.token_requested_by]
      .map(n => (n||'').trim().toLowerCase()).filter(Boolean);
    if (!names.length) return ccStr;

    const { rows } = await _pool.query(
      `SELECT email FROM users WHERE LOWER(name) = ANY($1) AND is_active=TRUE`,
      [names]
    );

    const existing = (ccStr || '').split(',').map(e => e.trim()).filter(Boolean);
    const blocked = [...existing, ...(toStr||'').split(',').map(e => e.trim())]
      .map(e => e.toLowerCase()).filter(Boolean);
    const toAdd = rows.map(r => r.email).filter(e => e && !blocked.includes(e.toLowerCase()));
    if (!toAdd.length) return existing.join(', ');

    console.log(`Staff CC added: ${toAdd.join(', ')}`);
    return [...existing, ...toAdd].join(', ');
  } catch (e) { console.error('addStaffEmails error:', e.message); return ccStr; }
}

// City-based CC routing — cluster heads receive a copy of all property emails for their city
function getCityCc(city) {
  const c = (city || '').toLowerCase();
  if (c.includes('gurgaon') || c.includes('gurugram')) return 'shashank.kumar@openhouse.in';
  if (c.includes('ghaziabad') || c.includes('gzb')) return 'animesh.singh@openhouse.in';
  if (c.includes('noida')) return 'abhishek.rathore@openhouse.in';
  return null;
}
function appendCityCc(ccStr, city) {
  const cityCc = getCityCc(city);
  if (!cityCc) return ccStr || '';
  const existing = (ccStr || '').split(',').map(e => e.trim()).filter(Boolean);
  if (existing.some(e => e.toLowerCase() === cityCc.toLowerCase())) return existing.join(', ');
  existing.push(cityCc);
  return existing.join(', ');
}

// sendWithThreadFallback (cross-mailbox threadId fallback + transient-network
// retry with Message-ID dedup) lives in ./gmail-send and is required at the top.

// Test UIDs — override recipients per email type
// To add test UIDs: add entries below. To disable: remove the UID key.
const TEST_OVERRIDES = {
  'OHGC1001': {
    token_request:    { to: 'ashish@openhouse.in,sahaj.dureja@openhouse.in', cc: 'durejasahaj@gmail.com' },
    deal_terms:       { to: 'saransh.khera@openhouse.in', cc: 'saranshkhera5@gmail.com' },
    pending_amount:   { to: 'ashish@openhouse.in,sahaj.dureja@openhouse.in', cc: null },
    key_handover:     { to: 'ashish@openhouse.in', cc: null },
    cp_bill:          { to: 'ashish@openhouse.in', cc: null },
  }
};
function testOverride(uid, emailType, to, cc, fromEmail) {
  const cfg = TEST_OVERRIDES[uid]?.[emailType];
  if (cfg) {
    console.log(`TEST MODE: ${uid}/${emailType} → To: ${cfg.to}, CC: ${cfg.cc||'none'}`);
    return { to: cfg.to, cc: cfg.cc };
  }
  return { to, cc };
}

// Generate real PDF buffer from HTML using Puppeteer
async function htmlToPdf(html) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    const pdfUint8 = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' }
    });
    // CRITICAL: Puppeteer returns Uint8Array, must convert to proper Node Buffer
    return Buffer.from(pdfUint8);
  } finally {
    if (browser) await browser.close();
  }
}

// Split base64 into 76-char lines (MIME requirement)
function chunkBase64(base64str) {
  const lines = [];
  for (let i = 0; i < base64str.length; i += 76) {
    lines.push(base64str.substring(i, i + 76));
  }
  return lines.join('\r\n');
}

// Generate RFC 2822 Message-ID
function generateMsgId() {
  return `<${Date.now()}.${Math.random().toString(36).slice(2)}@openhouse.in>`;
}

// Build RFC 2822 MIME email with PDF attachment
// Gmail rejects the whole send with "Invalid To header" if any address is malformed.
// A single DB field can hold two addresses typed with a space/semicolon between them
// ("a@x.com b@y.com"), which join(', ') would pass straight through. Split on every
// plausible separator, drop anything that isn't an address, and de-dupe.
function normalizeAddrList(str) {
  if (!str) return '';
  const seen = new Set();
  const out = [];
  for (const raw of String(str).split(/[,;\s]+/)) {
    const a = raw.trim().replace(/^<|>$/g, '');
    if (!a) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) { console.warn(`Email: dropping invalid address "${a}"`); continue; }
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.join(', ');
}

function buildMimeEmail({ from, to, cc, subject, bodyHtml, pdfBuffer, pdfFilename, references }) {
  to = normalizeAddrList(to);
  cc = normalizeAddrList(cc);
  if (!to) throw new Error('No valid recipient address after normalising the To list');
  const boundary = 'boundary_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
  const pdfBase64 = chunkBase64(Buffer.from(pdfBuffer).toString('base64'));
  const msgId = generateMsgId();

  const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';

  const mime = [
    'MIME-Version: 1.0',
    `Message-ID: ${msgId}`,
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${encodedSubject}`,
    references ? `In-Reply-To: ${references}` : null,
    references ? `References: ${references}` : null,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    bodyHtml,
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfFilename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${pdfFilename}"`,
    '',
    pdfBase64,
    '',
    `--${boundary}--`,
    ''
  ].filter(line => line !== null).join('\r\n');

  // Gmail API needs URL-safe base64
  const raw = Buffer.from(mime, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { raw, msgId };
}

// Send email via Gmail API using user's OAuth tokens
// Render one brokerage cell: "2% (₹12,34,000)" — pct and/or amount, "—" if neither.
function brokerageCell(pct, amount) {
  const p = (pct !== null && pct !== undefined && pct !== '') ? `${pct}%` : '';
  const a = (amount !== null && amount !== undefined && amount !== '') ? Number(String(amount).replace(/,/g, '')) : null;
  const aStr = (a !== null && !isNaN(a) && a > 0) ? ` (₹${a.toLocaleString('en-IN')})` : '';
  return (p + aStr) || '—';
}

async function sendTokenRequestEmail({ accessToken, refreshToken, fromEmail, property, pdfHtml, threadId, references }) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Generate PDF
  console.log('Generating PDF via Puppeteer...');
  const pdfBuffer = await htmlToPdf(pdfHtml);
  console.log(`PDF generated: ${pdfBuffer.length} bytes, isBuffer: ${Buffer.isBuffer(pdfBuffer)}`);

  // Verify PDF starts with %PDF
  const pdfHeader = pdfBuffer.slice(0, 5).toString('ascii');
  console.log(`PDF header: ${pdfHeader}`);
  if (!pdfHeader.startsWith('%PDF')) {
    throw new Error('Generated file is not a valid PDF');
  }

  const p = property;
  const ownerName = p.owner_broker_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Owner';
  const tower = p.tower_no || '';
  const unit = p.unit_no || '';
  const society = p.society_name || 'Property';
  const tokenAmt = p.deal_token_amount!=null&&p.deal_token_amount!=='' ? '₹ ' + Number(p.deal_token_amount).toLocaleString('en-IN') : '';

  const subject = `${p.uid} - Token Request | ${tower} ${unit} - ${society} | ${ownerName}`.replace(/\s+/g, ' ').trim();

  const senderName = fromEmail.split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const bodyHtml = `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.8">
<p>Greetings of the day!</p>
<p>Dear Accounts Team,</p>
<p>Kindly process the token payment of <strong>${tokenAmt}</strong> for <strong>${tower}${tower && unit ? ' -' : ''}${unit} ${society}</strong>. PFA the deal terms.</p>
${p.token_remarks ? `<p><strong>Internal Team Remarks:</strong> ${p.token_remarks}</p>` : ''}
${(String(p.source || '').trim().toLowerCase() !== 'direct' && (p.brokerage_ama_signed || p.brokerage_registry)) ? `<p style="margin-top:16px"><strong>Brokerage:</strong></p>
<table style="font-size:13px;border-collapse:collapse;margin:2px 0 8px">
<tr><td style="padding:1px 16px 1px 0">Agreed Brokerage:</td><td>${brokerageCell(p.agreed_brokerage, p.total_brokerage_amount)}</td></tr>
<tr><td style="padding:1px 16px 1px 0">Brokerage (AMA signed):</td><td>${brokerageCell(p.brokerage_ama_signed, p.brokerage_ama_signed_amount)}</td></tr>
<tr><td style="padding:1px 16px 1px 0">Brokerage (Registry):</td><td>${brokerageCell(p.brokerage_registry, p.brokerage_registry_amount)}</td></tr>
</table>` : ''}
${p.token_remarks_printed && p.token_remarks_printed.trim() ? `<p style="font-style:italic;margin-top:16px"><strong>Remarks:</strong><br>${p.token_remarks_printed.trim().replace(/</g,'&lt;').replace(/\n/g,'<br>')}</p>` : ''}
<p>Rahool Sureka, please approve the same.</p>
${p.cheque_image_url ? `<p style="margin-top:16px"><strong>Cancelled Cheque Link:</strong> <a href="${p.cheque_image_url}" target="_blank" style="color:#1a73e8;text-decoration:underline">Click here to view cheque</a></p>` : ''}
${p.owner_pan_url ? `<p><strong>PAN Card:</strong> <a href="${p.owner_pan_url}" target="_blank" style="color:#1a73e8;text-decoration:underline">Click here to view</a></p>` : ''}
${p.owner_aadhaar_front_url ? `<p><strong>Aadhaar Card Front:</strong> <a href="${p.owner_aadhaar_front_url}" target="_blank" style="color:#1a73e8;text-decoration:underline">Click here to view</a></p>` : ''}
${p.owner_aadhaar_back_url ? `<p><strong>Aadhaar Card Back:</strong> <a href="${p.owner_aadhaar_back_url}" target="_blank" style="color:#1a73e8;text-decoration:underline">Click here to view</a></p>` : ''}
${p.owner_property_doc_url ? `<p><strong>Property Ownership Document:</strong> <a href="${p.owner_property_doc_url}" target="_blank" style="color:#1a73e8;text-decoration:underline">Click here to view</a></p>` : ''}<br>
<p>Regards,<br><strong>${senderName}</strong></p>
</body></html>`;

  const pdfFilename = `Token_Request_${p.uid || 'receipt'}.pdf`;

  console.log('Building MIME email...');
  // Add Shrey to CC for Noida / Ghaziabad
  const city = (p.city || '').toLowerCase();
  const isNoidaOrGzb = city.includes('noida') || city.includes('ghaziabad') || city.includes('gzb');
  const tokenCc = isNoidaOrGzb ? 'supply@openhouse.in, bookings@openhouse.in, shrey.vohra@openhouse.in' : 'supply@openhouse.in, bookings@openhouse.in';
  const tokenCcWithCity = appendCityCc(tokenCc, p.city);
  const {to:emailTo,cc:emailCc}=testOverride(p.uid,'token_request','accounts@openhouse.in, rahool@openhouse.in',tokenCcWithCity,fromEmail);
  const emailCcFinal = await addStaffEmails(emailTo, await addManagerEmails(emailTo, emailCc, fromEmail), p);
  const { raw, msgId } = buildMimeEmail({
    from: fromEmail,
    to: emailTo,
    cc: emailCcFinal,
    subject,
    bodyHtml,
    pdfBuffer,
    pdfFilename,
    references
  });

  console.log(`MIME raw length: ${raw.length} chars. Sending via Gmail API...`);
  const reqBody = { raw };
  if (threadId) reqBody.threadId = threadId;
  const result = await sendWithThreadFallback(gmail, reqBody, fromEmail);

  console.log(`Email sent! messageId: ${result.data.id}`);
  logger.logEmailSent(p.uid,'email_token_request',fromEmail,emailTo,emailCcFinal,result.data.id,subject).catch(()=>{});
  const realMsgId = await getMessageId(gmail, result.data.id);
  return { messageId: result.data.id, threadId: result.data.threadId, rfc822MsgId: realMsgId || msgId };
}

// Send Deal Terms email to seller with PDF attachment
async function sendDealTermsEmail({ accessToken, refreshToken, fromEmail, property, pdfHtml, signatoryName, signatoryPhone, threadId, references }) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  console.log('Generating Deal Terms PDF via Puppeteer...');
  const pdfBuffer = await htmlToPdf(pdfHtml);
  console.log(`PDF generated: ${pdfBuffer.length} bytes`);

  const p = property;
  const sellerName = p.owner_broker_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Seller';
  const tower = p.tower_no || '';
  const unit = p.unit_no || '';
  const society = p.society_name || 'Property';
  const propRef = [tower, unit].filter(Boolean).join(' ') + (tower || unit ? ' - ' : '') + society;
  const tokenAmt = p.deal_token_amount;
  const tokenAmtFmt = tokenAmt!=null&&tokenAmt!=='' ? 'INR ' + Number(tokenAmt).toLocaleString('en-IN') + '/-' : 'INR [Token Amount]';
  const neftRef = p.deal_neft_reference || '[Transaction Reference No.]';

  const subject = `${p.uid} - Openhouse Offer | ${tower} ${unit} - ${society} | ${sellerName}`.replace(/\s+/g, ' ').trim();

  const bodyHtml = `<html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.8">
<p>Dear <strong>${sellerName}</strong>,</p>
<p>Greetings from <strong>Openhouse</strong>!</p>
<p>We are pleased to extend a formal offer for ${propRef}.</p>
<p>As a token of our commitment, we have transferred ${tokenAmtFmt} via NEFT, bearing Reference No. ${neftRef}, as an advance token towards this transaction. Further to our discussion, we have <strong>ATTACHED THE AGREED DEAL TERMS</strong> for your reference. <strong>Please review the document carefully.</strong></p>
${p.token_remarks_printed && p.token_remarks_printed.trim() ? `<p style="font-style:italic;margin-top:16px"><strong>Remarks:</strong><br>${p.token_remarks_printed.trim().replace(/</g,'&lt;').replace(/\n/g,'<br>')}</p>\n` : ''}<p>Kindly upload the required documents using the link - <a href="https://openhouse.in/login/" style="color:#1a73e8">Seller Dashboard</a></p>
<p>Login using your mobile number <strong>${p.contact_no||'[Owner Mobile No]'}</strong> &amp; OTP</p>
<p>Next Steps:-<br>
1. Document due diligence within 2 working days<br>
2. AMA signing<br>
3. Property Handover</p>
<p>Should you have any questions or require any clarification regarding the above, please do not hesitate to reach out to us. We are here to assist you at every step.</p>
<p><strong>List of documents required for AMA:</strong><br>
1) Allotment Letter issued by the Builder<br>
2) Possession Letter/Certificate by the Builder<br>
3) Builder Buyer Agreement (if applicable)<br>
4) Conveyance Deed/Sub Lease Deed/Sale Deed<br>
5) Car Parking letter (if applicable)<br>
6) Bank LOD (in case if active home loan)<br>
7) Bank NOC (in case of home loan closure)<br>
8) Aadhaar, PAN and Canceled Cheque of Co-applicant (if applicable)</p>
<p>Warm regards<br>
${signatoryName}<br>
${signatoryPhone ? signatoryPhone + '<br>' : ''}Website - <a href="https://www.openhouse.in" style="color:#1a73e8">www.openhouse.in</a></p>
</body></html>`;

  const pdfFilename = `Deal_Terms_${p.uid || 'receipt'}.pdf`;

  // Build recipient list
  const toList = [p.owner_email, p.co_owner_email, p.third_owner_email].filter(Boolean);
  const ccList = ['supply@openhouse.in', 'bookings@openhouse.in', 'accounts@openhouse.in',  p.broker_email].filter(Boolean);
  const dtCcStr = appendCityCc(ccList.join(', '), p.city);

  console.log('Building MIME email with PDF attachment...');
  const {to:dtTo,cc:dtCc}=testOverride(p.uid,'deal_terms',toList.join(', '),dtCcStr||null,fromEmail);
  const dtCcFinal = await addStaffEmails(dtTo, await addManagerEmails(dtTo, dtCc, fromEmail), p);
  const { raw, msgId } = buildMimeEmail({
    from: fromEmail,
    to: dtTo,
    cc: dtCcFinal,
    subject,
    bodyHtml,
    pdfBuffer,
    pdfFilename,
    references
  });

  const dtReqBody = { raw };
  if (threadId) dtReqBody.threadId = threadId;
  const result = await sendWithThreadFallback(gmail, dtReqBody, fromEmail);
  console.log(`Deal Terms email sent! messageId: ${result.data.id}`);
  logger.logEmailSent(p.uid,'email_deal_terms',fromEmail,dtTo,dtCcFinal,result.data.id,subject).catch(()=>{});
  const realMsgId = await getMessageId(gmail, result.data.id);
  return { messageId: result.data.id, threadId: result.data.threadId, rfc822MsgId: realMsgId || msgId };
}

// Build simple HTML email (no attachment)
function buildSimpleMimeEmail({ from, to, cc, subject, bodyHtml, references }) {
  const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
  const msgId = generateMsgId();
  const mime = [
    'MIME-Version: 1.0',
    `Message-ID: ${msgId}`,
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${encodedSubject}`,
    references ? `In-Reply-To: ${references}` : null,
    references ? `References: ${references}` : null,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    bodyHtml
  ].filter(line => line !== null).join('\r\n');
  const raw = Buffer.from(mime, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { raw, msgId };
}

// Fetch ACTUAL Message-ID from Gmail after sending (requires gmail.readonly).
// Best-effort only — caller falls back to our own Message-ID if this returns null.
// Pass Accept-Encoding: identity to dodge the node-fetch gzip "Premature close" bug,
// and skip entirely when there's no id (e.g. send recovered without one).
async function getMessageId(gmail, messageId) {
  if (!messageId) return null;
  try {
    const msg = await gmail.users.messages.get(
      { userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['Message-Id'] },
      READ_OPTS
    );
    const hdr = msg.data.payload.headers.find(h => h.name.toLowerCase() === 'message-id');
    return hdr ? hdr.value : null;
  } catch(e) { console.error('getMessageId error:', e.message); return null; }
}

// Send CP Bill email via Gmail API
async function sendCPBillEmail({ accessToken, refreshToken, fromEmail, senderName, property, threadId, references }) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const p = property;
  const addr = [p.tower_no, p.unit_no, p.society_name, p.locality, p.city].filter(Boolean).join(', ');

  const isFirm = p.cp_firm && p.cp_firm !== 'INDIVIDUAL';
  const isGstYes = isFirm && p.gst_applicable === 'Yes';
  const isFirmNoGst = isFirm && !isGstYes;
  const photoLinks = [];
  if(!isFirm && p.cp_aadhaar_front_url) photoLinks.push(`<li><a href="${p.cp_aadhaar_front_url}" target="_blank">Aadhaar Card Front</a></li>`);
  if(!isFirm && p.cp_aadhaar_back_url) photoLinks.push(`<li><a href="${p.cp_aadhaar_back_url}" target="_blank">Aadhaar Card Back</a></li>`);
  if(isFirmNoGst && p.cp_coi_url) photoLinks.push(`<li><a href="${p.cp_coi_url}" target="_blank">Certificate of Incorporation</a></li>`);
  if(!isGstYes && p.cp_pan_card_url) photoLinks.push(`<li><a href="${p.cp_pan_card_url}" target="_blank">PAN Card</a></li>`);
  if(p.cp_cancelled_cheque_url) photoLinks.push(`<li><a href="${p.cp_cancelled_cheque_url}" target="_blank">Cancelled Cheque</a></li>`);
  if(isGstYes && p.cp_gst_invoice_url) photoLinks.push(`<li><a href="${p.cp_gst_invoice_url}" target="_blank">GST Invoice</a></li>`);

  const subject = `${p.uid} - CP Bill Request | ${p.tower_no||''} ${p.unit_no||''} - ${p.society_name||'Property'} | ${p.cp_name||'CP'}`.replace(/\s+/g, ' ').trim();
  const bodyHtml = `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.8">
<p>Hi Accounts Team,</p>
<p>Kindly prepare the CP bill for the below mentioned property:</p>
<table style="border-collapse:collapse;font-size:14px;line-height:2">
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">Deal Type:</td><td>${p.deal_type||'—'}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">CP Name:</td><td>${p.cp_name||'—'}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">CP Firm:</td><td>${(!p.cp_firm||p.cp_firm==='INDIVIDUAL')?'Individual':p.cp_firm}</td></tr>
  ${p.cp_firm&&p.cp_firm!=='INDIVIDUAL'?`<tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">GST Applicable:</td><td>${p.gst_applicable||'No'}</td></tr>`:''}
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">Mobile Number:</td><td>${p.cp_phone||'—'}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">Email ID:</td><td>${p.cp_email||'—'}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">Property Address:</td><td>${addr}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">OH Acquired Model:</td><td>${p.oh_acquired_model||'—'}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">Agreed Brokerage:</td><td>${p.agreed_brokerage||'—'}%</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">Deal Value:</td><td>${p.deal_value||'—'}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">Total Brokerage:</td><td>${p.total_brokerage_amount?'₹'+Number(p.total_brokerage_amount).toLocaleString('en-IN'):'—'}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">To be Released Now:</td><td>${p.to_be_released_now?'₹'+Number(p.to_be_released_now).toLocaleString('en-IN'):'—'}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">Incentive for Visit:</td><td>${p.incentive_visit?'₹'+Number(p.incentive_visit).toLocaleString('en-IN'):'—'}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">Incentive for Owner Meeting:</td><td>${p.incentive_owner_meeting?'₹'+Number(p.incentive_owner_meeting).toLocaleString('en-IN'):'—'}</td></tr>
  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap">Total Amount:</td><td>${p.total_cp_amount?'₹'+Number(p.total_cp_amount).toLocaleString('en-IN'):'—'}</td></tr>
${p.cp_bill_remarks?`  <tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap;vertical-align:top">Remarks:</td><td>${p.cp_bill_remarks}</td></tr>`:''}
</table>
${photoLinks.length?`<p style="margin-top:16px"><strong>Attached Documents:</strong></p><ul style="line-height:2">${photoLinks.join('')}</ul>`:''}
<p style="margin-top:16px">Prashant Singh, kindly approve the same.</p>
<p>Best,<br><strong>${senderName}</strong></p>
</body></html>`;

  const cpCcStr = appendCityCc('supply@openhouse.in', p.city);
  const {to:cpTo,cc:cpCc}=testOverride(p.uid,'cp_bill','prashant@openhouse.in,accounts@openhouse.in',cpCcStr,fromEmail);
  const cpCcFinal = await addStaffEmails(cpTo, await addManagerEmails(cpTo, cpCc, fromEmail), p);
  const { raw, msgId } = buildSimpleMimeEmail({
    from: fromEmail,
    to: cpTo,
    cc: cpCcFinal,
    subject,
    bodyHtml,
    references
  });

  const cpReqBody = { raw };
  if (threadId) cpReqBody.threadId = threadId;
  const result = await sendWithThreadFallback(gmail, cpReqBody, fromEmail);
  console.log(`CP Bill email sent! messageId: ${result.data.id}`);
  logger.logEmailSent(p.uid,'email_cp_bill',fromEmail,cpTo,cpCcFinal,result.data.id,subject).catch(()=>{});
  const realMsgId = await getMessageId(gmail, result.data.id);
  return { messageId: result.data.id, threadId: result.data.threadId, rfc822MsgId: realMsgId || msgId };
}

async function sendPendingAmountEmail({ accessToken, refreshToken, fromEmail, senderName, property, owner1_name, owner1_amount, owner2_name, owner2_amount, threadId, references }) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const p = property;
  const addr = [p.tower_no, p.unit_no, p.society_name, p.locality, p.city].filter(Boolean).join(', ');
  const amaDate = p.ama_date ? new Date(p.ama_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const ownerName = owner1_name || p.owner_broker_name || 'Owner';

  let amountLines = `<ul style="line-height:2;font-size:14px">
    <li><strong>${ownerName}:</strong> INR ${Number(owner1_amount||0).toLocaleString('en-IN')}</li>`;
  if (owner2_name && owner2_amount) {
    amountLines += `<li><strong>${owner2_name}:</strong> INR ${Number(owner2_amount).toLocaleString('en-IN')}</li>`;
  }
  amountLines += `</ul>`;

  const subject = `${p.uid} - Openhouse Offer | ${p.tower_no||''} ${p.unit_no||''} - ${p.society_name||'Property'} | ${ownerName}`.replace(/\s+/g, ' ').trim();
  const bodyHtml = `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.8">
<p>Dear <strong>${ownerName}</strong>,</p>
<p>Congratulations on the successful execution of the Asset Management Agreement dated <strong>${amaDate}</strong>.</p>
<p>Please find the link to executed copy of the agreement for your reference. Kindly acknowledge receipt of this document by replying to this thread. Upon receiving your acknowledgement, the Accounts Team will release the remaining amount as follows:</p>
<p><strong>Property:</strong> ${addr}</p>
${amountLines}
<p>Hi Accounts Team, please do the needful.</p>
${owner2_name ? [
  p.co_owner_cheque_url ? `<p><strong>Co Owner Cancelled Cheque Link:</strong> <a href="${p.co_owner_cheque_url}" style="color:#1a73e8">Click here to view</a></p>` : '',
  p.co_owner_pan_url ? `<p><strong>Co Owner PAN Card:</strong> <a href="${p.co_owner_pan_url}" style="color:#1a73e8">Click here to view</a></p>` : '',
  p.co_owner_aadhaar_front_url ? `<p><strong>Co Owner Aadhaar Card Front:</strong> <a href="${p.co_owner_aadhaar_front_url}" style="color:#1a73e8">Click here to view</a></p>` : '',
  p.co_owner_aadhaar_back_url ? `<p><strong>Co Owner Aadhaar Card Back:</strong> <a href="${p.co_owner_aadhaar_back_url}" style="color:#1a73e8">Click here to view</a></p>` : ''
].filter(Boolean).join('\n') : ''}
${p.signed_ama_url ? `<p><strong>AMA Link:</strong> <a href="${p.signed_ama_url}" style="color:#1a73e8">Click here to view AMA</a></p>` : ''}
<p>Regards,<br><strong>${senderName}</strong></p>
</body></html>`;

  const toList = [p.owner_email, p.co_owner_email, p.third_owner_email, 'accounts@openhouse.in'].filter(Boolean);
  const ccList = ['supply@openhouse.in', 'bookings@openhouse.in', 'accounts@openhouse.in'].filter(Boolean);
  const paCcStr = appendCityCc(ccList.join(', '), p.city);

  const {to:paTo,cc:paCc}=testOverride(p.uid,'pending_amount',toList.join(', '),paCcStr||'',fromEmail);
  const paCcFinal = await addStaffEmails(paTo, await addManagerEmails(paTo, paCc, fromEmail), p);
  const { raw, msgId } = buildSimpleMimeEmail({
    from: fromEmail,
    to: paTo,
    cc: paCcFinal,
    subject,
    bodyHtml,
    references
  });

  const paReqBody = { raw };
  if (threadId) paReqBody.threadId = threadId;
  const result = await sendWithThreadFallback(gmail, paReqBody, fromEmail);
  console.log(`Pending amount email sent! messageId: ${result.data.id}`);
  logger.logEmailSent(p.uid,'email_pending_amount',fromEmail,paTo,paCcFinal,result.data.id,subject).catch(()=>{});
  const realMsgId = await getMessageId(gmail, result.data.id);
  return { messageId: result.data.id, threadId: result.data.threadId, rfc822MsgId: realMsgId || msgId };
}

async function sendKeyHandoverEmail({ accessToken, refreshToken, fromEmail, senderName, property, threadId, references }) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const p = property;
  const addr = [p.tower_no, p.unit_no, p.society_name, p.locality, p.city].filter(Boolean).join(', ');
  const sellerName = p.owner_broker_name || 'Seller';
  const hdDate = p.key_handover_date ? new Date(p.key_handover_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

  const subject = `${p.uid} - Openhouse Offer | ${p.tower_no||''} ${p.unit_no||''} - ${p.society_name||'Property'} | ${sellerName}`.replace(/\s+/g, ' ').trim();
  const bodyHtml = `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.8">
<p>Dear <strong>${sellerName}</strong>,</p>
<p>This email serves as official confirmation that we collected the keys to your property <strong>${addr}</strong> on <strong>${hdDate}</strong>. Consequently, the timeline of the agreement will commence from <strong>${hdDate}</strong>. Please consider this message as formal notification regarding the start of our timeline.</p>

<p>Regards,<br><strong>${senderName}</strong></p>
</body></html>`;

  const toList = [p.owner_email, p.co_owner_email, p.third_owner_email].filter(Boolean);
  const ccList = ['supply@openhouse.in', 'bookings@openhouse.in', 'accounts@openhouse.in', p.broker_email].filter(Boolean);
  const khCcStr = appendCityCc(ccList.join(', '), p.city);

  const {to:khTo,cc:khCc}=testOverride(p.uid,'key_handover',toList.join(', '),khCcStr||null,fromEmail);
  const khCcFinal = await addStaffEmails(khTo, await addManagerEmails(khTo, khCc, fromEmail), p);
  const { raw, msgId } = buildSimpleMimeEmail({
    from: fromEmail,
    to: khTo,
    cc: khCcFinal,
    subject,
    bodyHtml,
    references
  });

  const khReqBody = { raw };
  if (threadId) khReqBody.threadId = threadId;
  const result = await sendWithThreadFallback(gmail, khReqBody, fromEmail);
  console.log(`Key handover email sent! messageId: ${result.data.id}`);
  logger.logEmailSent(p.uid,'email_key_handover',fromEmail,khTo,khCcFinal,result.data.id,subject).catch(()=>{});
  const realMsgId = await getMessageId(gmail, result.data.id);
  return { messageId: result.data.id, threadId: result.data.threadId, rfc822MsgId: realMsgId || msgId };
}

// Send offer email to property owner with PDF attachment
module.exports = { init, sendTokenRequestEmail, sendDealTermsEmail, sendCPBillEmail, sendPendingAmountEmail, sendKeyHandoverEmail, htmlToPdf, normalizeAddrList }; 