// Gmail messages.send is a non-idempotent POST, and gaxios does NOT auto-retry
// POST (it's absent from httpMethodsToRetry). So a transient network blip like
// ERR_STREAM_PREMATURE_CLOSE bubbles straight up and the send is reported failed.
// These blips usually surface while reading the *response* — meaning Gmail has
// already accepted the message — so we retry, but dedupe on the MIME's Message-ID
// (rfc822msgid: search) to avoid sending a duplicate. Requires gmail.readonly.

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

// Single send, with the existing cross-mailbox threadId fallback. A threadId that
// belongs to another mailbox makes Gmail reject the send; retry header-only.
async function sendOnce(gmail, requestBody, fromEmail) {
  try {
    return await gmail.users.messages.send({ userId: 'me', requestBody });
  } catch (e) {
    if (requestBody.threadId && isThreadNotFoundError(e)) {
      console.log(`Thread ${requestBody.threadId} not in ${fromEmail}'s mailbox — retrying without threadId`);
      const { threadId, ...rest } = requestBody;
      return await gmail.users.messages.send({ userId: 'me', requestBody: rest });
    }
    throw e;
  }
}

async function sendWithThreadFallback(gmail, requestBody, fromEmail, { retries = 2, baseDelay = 1000 } = {}) {
  const msgId = extractMessageId(requestBody.raw);
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendOnce(gmail, requestBody, fromEmail);
    } catch (e) {
      if (!isTransient(e) || attempt >= retries) throw e;
      await sleep(baseDelay * (attempt + 1)); // also gives Gmail time to index before we check
      // Did a prior attempt actually land? If so, don't resend a duplicate.
      if (msgId) {
        try {
          const found = await gmail.users.messages.list({ userId: 'me', q: `rfc822msgid:${msgId}` });
          if (found?.data?.messages?.length) {
            console.log(`Send recovered: ${msgId} already in ${fromEmail}'s mailbox after ${e.code || e.message}`);
            return { data: found.data.messages[0] };
          }
        } catch (_) { /* search failed — fall through and resend */ }
      }
      console.log(`Retrying send for ${fromEmail} after ${e.code || e.message} (attempt ${attempt + 1}/${retries})`);
    }
  }
}

module.exports = { sendWithThreadFallback, isTransient, isThreadNotFoundError, extractMessageId };

// ponytail: self-check for transient-retry + dedup. Run: node utils/gmail-send.js
if (require.main === module) {
  const assert = require('assert');
  (async () => {
    const raw = Buffer.from('Message-ID: <abc.def@openhouse.in>\r\nFrom: x\r\n\r\nbody').toString('base64');
    const opts = { baseDelay: 5 }; // keep the check fast

    assert.strictEqual(extractMessageId(raw), 'abc.def@openhouse.in', 'extracts Message-ID');

    // Premature close but Gmail already has it → recover via lookup, do NOT resend.
    let sends = 0;
    const delivered = { users: { messages: {
      send: async () => { sends++; const e = new Error('Premature close'); e.code = 'ERR_STREAM_PREMATURE_CLOSE'; throw e; },
      list: async () => ({ data: { messages: [{ id: 'EXISTING' }] } }),
    } } };
    const r1 = await sendWithThreadFallback(delivered, { raw }, 'a@openhouse.in', opts);
    assert.strictEqual(r1.data.id, 'EXISTING');
    assert.strictEqual(sends, 1, 'must NOT resend when message already delivered');

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
