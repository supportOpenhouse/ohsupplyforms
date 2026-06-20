// Gmail messages.send is a non-idempotent POST. A transient blip like
// ERR_STREAM_PREMATURE_CLOSE can surface either while UPLOADING the request (message
// NOT sent) or while READING the response (message already delivered) — the error looks
// identical either way. So after a blip we neither blindly resend (→ duplicates) nor
// blindly assume-delivered (→ silent drops). We look the message up by its MIME
// Message-ID (rfc822msgid: search) and resend only when it's genuinely not in the
// mailbox; if it ultimately didn't send, we THROW so the caller reports a real failure.
// Requires gmail.readonly.
const https = require('https');

// Force a FRESH socket per request. Node 19+ defaults keepAlive=true, and reused
// keep-alive sockets to Gmail get closed mid-request → ERR_STREAM_PREMATURE_CLOSE.
// A new socket per request is the actual fix for the premature-close storm.
const noKeepAlive = new https.Agent({ keepAlive: false });

// Per-request transport options (these propagate; global google.options headers do not):
//  - agent           → fresh socket, no stale keep-alive close
//  - Accept-Encoding  → identity, dodges the node-fetch gzip "Premature close" bug
//  - retry:false      → stop gaxios silently auto-resending this non-idempotent POST
const SEND_OPTS = { agent: noKeepAlive, headers: { 'Accept-Encoding': 'identity' }, retry: false, retryConfig: { retry: 0, noResponseRetries: 0 } };
const READ_OPTS = { agent: noKeepAlive, headers: { 'Accept-Encoding': 'identity' } };

const TRANSIENT = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND']);

function isTransient(e) {
  const code = e?.code || e?.cause?.code;
  if (TRANSIENT.has(code)) return true;
  const status = e?.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /premature close|socket hang up|network|ECONNRESET|ETIMEDOUT/i.test(e?.message || '');
}

function isThreadNotFoundError(e) {
  const msg = e?.message || '';
  const code = e?.code || e?.response?.status;
  if (code === 404) return true;
  return /thread/i.test(msg) && /(not found|invalid|does not exist)/i.test(msg);
}

function extractMessageId(rawB64) {
  try {
    const m = Buffer.from(rawB64 || '', 'base64').toString('utf8').match(/^Message-ID:\s*<([^>]+)>/im);
    return m ? m[1] : null;
  } catch { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Is a message with this MIME Message-ID already in the mailbox? (Best-effort.)
async function findSent(gmail, msgId) {
  if (!msgId) return null;
  try {
    const r = await gmail.users.messages.list({ userId: 'me', q: `rfc822msgid:${msgId}` }, READ_OPTS);
    return r?.data?.messages?.length ? r.data.messages[0] : null;
  } catch (_) { return null; }
}

// Single send, with the existing cross-mailbox threadId fallback. A threadId that
// belongs to another mailbox makes Gmail reject the send; retry header-only.
async function sendOnce(gmail, requestBody, fromEmail) {
  try {
    return await gmail.users.messages.send({ userId: 'me', requestBody }, SEND_OPTS);
  } catch (e) {
    if (requestBody.threadId && isThreadNotFoundError(e)) {
      console.log(`Thread ${requestBody.threadId} not in ${fromEmail}'s mailbox — retrying without threadId`);
      const { threadId, ...rest } = requestBody;
      return await gmail.users.messages.send({ userId: 'me', requestBody: rest }, SEND_OPTS);
    }
    throw e;
  }
}

async function sendWithThreadFallback(gmail, requestBody, fromEmail, { retries = 2, baseDelay = 2000 } = {}) {
  const msgId = extractMessageId(requestBody.raw);
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendOnce(gmail, requestBody, fromEmail);
    } catch (e) {
      if (!isTransient(e)) throw e; // genuine fatal (auth/format) — surface immediately
      // Ambiguous blip: wait for Gmail to index a possibly-delivered copy, then check
      // before deciding to resend. This avoids both duplicates and silent drops.
      await sleep(baseDelay * (attempt + 1));
      const landed = await findSent(gmail, msgId);
      if (landed) {
        console.log(`Confirmed delivered (no resend): ${msgId} for ${fromEmail} after ${e.code || e.message}`);
        return { data: landed };
      }
      if (attempt >= retries) {
        // Not in the mailbox after every retry — it truly didn't send. Report failure
        // (the caller turns this into an error response — never a fake "sent").
        console.error(`Send FAILED for ${fromEmail} after ${attempt + 1} attempts (${e.code || e.message}); not found in mailbox`);
        throw e;
      }
      console.log(`Not delivered yet — resending for ${fromEmail} after ${e.code || e.message} (attempt ${attempt + 1}/${retries})`);
    }
  }
}

module.exports = { sendWithThreadFallback, findSent, READ_OPTS, SEND_OPTS, isTransient, isThreadNotFoundError, extractMessageId };

// Self-check: never-drop / never-duplicate retry semantics. Run: node utils/gmail-send.js
if (require.main === module) {
  const assert = require('assert');
  (async () => {
    const raw = Buffer.from('Message-ID: <abc.def@openhouse.in>\r\nFrom: x\r\n\r\nbody').toString('base64');
    const opts = { baseDelay: 5 }; // keep the check fast

    assert.strictEqual(extractMessageId(raw), 'abc.def@openhouse.in', 'extracts Message-ID');

    // Premature close but the message IS in the mailbox → no resend, return it.
    let sends = 0;
    const delivered = { users: { messages: {
      send: async () => { sends++; const e = new Error('Premature close'); e.code = 'ERR_STREAM_PREMATURE_CLOSE'; throw e; },
      list: async () => ({ data: { messages: [{ id: 'EXISTING' }] } }),
    } } };
    const r1 = await sendWithThreadFallback(delivered, { raw }, 'a@openhouse.in', opts);
    assert.strictEqual(r1.data.id, 'EXISTING');
    assert.strictEqual(sends, 1, 'must NOT resend when message already delivered');

    // Premature close AND never in mailbox (truly not sent) → resend, then FAIL loudly.
    let sendsFail = 0;
    const neverLands = { users: { messages: {
      send: async () => { sendsFail++; const e = new Error('Premature close'); e.code = 'ERR_STREAM_PREMATURE_CLOSE'; throw e; },
      list: async () => ({ data: { messages: [] } }),
    } } };
    await assert.rejects(() => sendWithThreadFallback(neverLands, { raw }, 'a@openhouse.in', opts), 'must throw, never fake success');
    assert.strictEqual(sendsFail, 3, 'tries 1 + 2 retries when never delivered');

    // Transient once, not delivered yet → resend once, succeed.
    let n = 0;
    const retry = { users: { messages: {
      send: async () => { n++; if (n === 1) { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; } return { data: { id: 'SENT' } }; },
      list: async () => ({ data: { messages: [] } }),
    } } };
    const r2 = await sendWithThreadFallback(retry, { raw }, 'a@openhouse.in', opts);
    assert.strictEqual(r2.data.id, 'SENT');
    assert.strictEqual(n, 2, 'must resend exactly once when not yet delivered');

    // Non-transient (400) → throw immediately, no retry.
    let fatal = 0;
    const fatalGmail = { users: { messages: {
      send: async () => { fatal++; const e = new Error('Bad Request'); e.response = { status: 400 }; throw e; },
      list: async () => ({ data: {} }),
    } } };
    await assert.rejects(() => sendWithThreadFallback(fatalGmail, { raw }, 'a@openhouse.in', opts));
    assert.strictEqual(fatal, 1, 'must NOT retry non-transient errors');

    console.log('gmail-send self-check passed');
  })().catch(e => { console.error('SELF-CHECK FAILED:', e); process.exit(1); });
}
