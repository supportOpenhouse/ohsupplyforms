# Interakt WhatsApp ID Tracking — Rollout Guide for Other Dashboards

Store every Interakt message id, and link it to the `activity_logs` row that caused it.

Reference implementation: **Forms** dashboard (`utils/whatsapp.js`, `utils/logger.js`, `db/migrate.js`).

---

## 0. First decide: shared DB or separate DB?

`activity_logs` has a `dashboard` column, and each app sets its own value
(`const DASHBOARD = 'Forms'` in `utils/logger.js`). So:

| Situation | What to do |
|---|---|
| Dashboard uses the **same** Postgres DB as Forms | **Skip Step 1.** Table + trigger already exist. Do Steps 2–3 only. |
| Dashboard has its **own** DB | Run Step 1 against that DB, then Steps 2–3. |

Confirm before doing anything:

```sql
SELECT to_regclass('wa_interakt_id') AS wa_table,
       to_regclass('activity_logs')  AS logs_table;
```

Both non-null → shared DB, skip Step 1.

---

## 1. Database (run ONCE per database)

Requires `activity_logs` to already exist (the FK points at it). Run this **after**
your logs-table migration.

```sql
CREATE TABLE IF NOT EXISTS wa_interakt_id (
  id_seq SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  result BOOLEAN,
  id TEXT,
  template TEXT,
  name TEXT,
  uid TEXT,
  log_id INTEGER,
  sent_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $wacol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wa_interakt_id' AND column_name='uid')
  THEN ALTER TABLE wa_interakt_id ADD COLUMN uid TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wa_interakt_id' AND column_name='log_id')
  THEN ALTER TABLE wa_interakt_id ADD COLUMN log_id INTEGER; END IF;
  -- ON DELETE SET NULL: purging old activity_logs must never delete delivery records.
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='fk_wa_log_id')
  THEN ALTER TABLE wa_interakt_id ADD CONSTRAINT fk_wa_log_id
       FOREIGN KEY (log_id) REFERENCES activity_logs(id) ON DELETE SET NULL; END IF;
END $wacol$;

CREATE INDEX IF NOT EXISTS idx_wa_phone    ON wa_interakt_id(phone);
CREATE INDEX IF NOT EXISTS idx_wa_id       ON wa_interakt_id(id);
CREATE INDEX IF NOT EXISTS idx_wa_sent     ON wa_interakt_id(sent_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_wa_template ON wa_interakt_id(template);
CREATE INDEX IF NOT EXISTS idx_wa_uid      ON wa_interakt_id(uid);
CREATE INDEX IF NOT EXISTS idx_wa_log_id   ON wa_interakt_id(log_id);
```

### Name auto-fill trigger

`name` is filled by a trigger, not app code, so **any** insert path gets it.
Matches on the **last 10 digits**, so `+91 97113 30512`, `09711330512` and
`9711330512` all resolve to the same person.

```sql
CREATE OR REPLACE FUNCTION wa_fill_name() RETURNS TRIGGER AS $wa$
DECLARE
  p TEXT := RIGHT(REGEXP_REPLACE(COALESCE(NEW.phone,''), '\D', '', 'g'), 10);
BEGIN
  IF NEW.name IS NOT NULL AND NEW.name <> '' THEN RETURN NEW; END IF;
  IF p = '' THEN RETURN NEW; END IF;

  SELECT u.name INTO NEW.name FROM users u
   WHERE RIGHT(REGEXP_REPLACE(COALESCE(u.phone,''), '\D', '', 'g'), 10) = p
     AND u.name IS NOT NULL AND u.name <> ''
   LIMIT 1;

  IF NEW.name IS NULL OR NEW.name = '' THEN
    SELECT pr.owner_broker_name INTO NEW.name FROM properties pr
     WHERE RIGHT(REGEXP_REPLACE(COALESCE(pr.contact_no,''), '\D', '', 'g'), 10) = p
       AND pr.owner_broker_name IS NOT NULL AND pr.owner_broker_name <> ''
     ORDER BY pr.created_at DESC
     LIMIT 1;
  END IF;

  RETURN NEW;
END;
$wa$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wa_fill_name ON wa_interakt_id;
CREATE TRIGGER trg_wa_fill_name BEFORE INSERT ON wa_interakt_id
  FOR EACH ROW EXECUTE FUNCTION wa_fill_name();
```

> **If your DB has no `users` / `properties` table**, drop or rewrite that lookup to
> point at your equivalent tables. The trigger will error on insert if it references
> a table that doesn't exist.

> **Embedding in JS?** Inside a JS template literal the regex must be written `'\\D'`
> so Postgres receives `'\D'`. The SQL above is the raw form — use it as-is in a
> `.sql` file.

---

## 2. Logger: return the row id + allow a later result update

The whole point is that WhatsApp is logged **before** sending, so the id exists to
attach to each message.

**2a. Make `log()` return the new id** (`RETURNING id`):

```js
async function log(uid, action, category, actorEmail, actorName, details = {}) {
  if (!_pool) return null;                     // was: return
  try {
    const { rows } = await _pool.query(
      `INSERT INTO activity_logs (uid, action, category, actor_email, actor_name, dashboard, details, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() AT TIME ZONE 'Asia/Kolkata') RETURNING id`,
      [uid || null, action, category, actorEmail || null, actorName || null, DASHBOARD, JSON.stringify(details)]
    );
    return rows.length ? rows[0].id : null;
  } catch (e) { console.error('Logger error:', e.message); return null; }
}
```

**2b. Add a results-folding helper**, so the log row keeps its existing
`details.recipients` shape and nothing downstream breaks:

```js
async function updateWhatsAppResults(logId, results) {
  if (!_pool || !logId) return;
  try {
    await _pool.query(
      `UPDATE activity_logs SET details = details || $2::jsonb WHERE id = $1`,
      [logId, JSON.stringify({ recipients: results || [] })]
    );
  } catch (e) { console.error('Logger error (wa results):', e.message); }
}
```

Export it: `module.exports = { ..., updateWhatsAppResults }`.

---

## 3. WhatsApp sender

**3a. Record every Interakt response.** Fire-and-forget — a logging failure must
never break a send. Note `name` is deliberately omitted; the trigger fills it.

```js
function recordInteraktId(phone, templateName, rawBody, ctx) {
  if (!_pool) return;
  let result = null, msgId = null;
  try {
    const parsed = JSON.parse(rawBody);
    result = typeof parsed.result === 'boolean' ? parsed.result : null;
    msgId = parsed.id || null;
  } catch (e) { /* non-JSON error body — still record the attempt */ }
  _pool.query(
    `INSERT INTO wa_interakt_id(phone, result, id, template, uid, log_id) VALUES($1,$2,$3,$4,$5,$6)`,
    [phone, result, msgId, templateName, ctx?.uid || null, ctx?.logId || null]
  ).catch(e => console.error('WA: failed to record interakt id:', e.message));
}
```

**3b. Call it in the response handler — and fix the 2xx check.**
Interakt returns **201**, so a `=== 200` test reports every successful send as failed:

```js
res.on('end', () => {
  console.log(`WA: [${res.statusCode}] ${phone}: ${data.substring(0, 200)}`);
  const ok = res.statusCode >= 200 && res.statusCode < 300;   // was: === 200
  recordInteraktId(phone, templateName, data, ctx);
  resolve(ok);
});
```

**3c. Thread `ctx` down the call chain.** Add a trailing `ctx` param to the sender and
the broadcaster, and pass it through:

```js
function sendInterakt(phone, templateName, bodyValues, ctx) { ... }

async function broadcastTemplate(templateName, bodyValues, recipients, ctx) {
  ...
  const ok = await sendInterakt(phone, templateName, bodyValues, ctx);
  ...
}
```

**3d. Log first, then send, then fold results back:**

```js
async function sendAndLog(uid, templateName, logAction, bodyValues, recipients, actor) {
  const logId = await logger.logWhatsApp(uid, logAction, recipients, actor?.email, actor?.name);
  const results = await broadcastTemplate(templateName, bodyValues, recipients, { uid, logId });
  logger.updateWhatsAppResults(logId, results).catch(() => {});
  return results;
}
```

Then rewrite each notify function from the old shape:

```js
// BEFORE — logs after sending, so no id exists to attach
return broadcastTemplate('visit_scheduled', bodyValues, r)
  .then(res => { logger.logWhatsApp(p.uid,'visit_scheduled',res,actor?.email,actor?.name).catch(()=>{}); return res; });

// AFTER
return sendAndLog(p.uid, 'visit_scheduled', 'visit_scheduled', bodyValues, r, actor);
```

`templateName` and `logAction` are separate on purpose — they sometimes differ
(e.g. template `token_request_o8` is logged as action `token_request`).

### ⚠️ The step that's easy to miss

Some flows call `sendInterakt()` **directly**, bypassing `broadcastTemplate` — extra
hardcoded numbers, owner / co-owner / CP phones, etc. Those need `ctx` too, or they
become orphan rows with null `uid`/`log_id`:

```js
const waLogId = await logger.logWhatsApp(p.uid, 'ama_signed', recipients, actor?.email, actor?.name);
const waCtx = { uid: p.uid, logId: waLogId };
const results = await broadcastTemplate('ama_signed', bodyValues, recipients, waCtx);
...
const ok = await sendInterakt(ownerPhone, 'ama_signed', bodyValues, waCtx);   // <-- ctx here too
...
logger.updateWhatsAppResults(waLogId, allRecipients).catch(()=>{});
```

Find them all with:

```bash
grep -n "sendInterakt(" utils/whatsapp.js | grep -v ", ctx)" | grep -v "waCtx)"
```

---

## 4. Verify

Run the migration, send one real message, then:

```sql
-- 1. Rows are being written, and the trigger resolved a name
SELECT phone, name, result, id, template, uid, log_id, sent_timestamp
FROM wa_interakt_id ORDER BY sent_timestamp DESC LIMIT 5;

-- 2. The join works both ways
SELECT a.action, a.dashboard, a.actor_name, w.phone, w.name, w.result, w.id
FROM activity_logs a
JOIN wa_interakt_id w ON w.log_id = a.id
ORDER BY w.sent_timestamp DESC LIMIT 20;

-- 3. Orphans = a sendInterakt call you missed threading ctx into
SELECT template, count(*) FROM wa_interakt_id
WHERE log_id IS NULL AND sent_timestamp > NOW() - INTERVAL '1 day'
GROUP BY template;
```

Checklist:

- [ ] `result = true` and `id` populated (not null) on a successful send
- [ ] `name` auto-filled for a known user and a known property contact
- [ ] `uid` + `log_id` populated
- [ ] Query 3 returns **no rows** for templates you've exercised
- [ ] `activity_logs.details.recipients` still populated as before

---

## Gotchas

- **Ordering.** Create/alter `wa_interakt_id` *after* `activity_logs` — the FK depends on it.
- **Rows created before this change** have `uid`/`log_id` NULL. Backfilling by
  phone+timestamp is guesswork; don't.
- **`id` is not the primary key.** It's null when a send fails, so the table uses a
  surrogate `id_seq`.
- **Don't pass `name` on insert.** Let the trigger own it — passing a value skips the lookup.
- **Failure rows are still recorded** (`result` null/false, `id` null). That's intentional:
  a failed attempt is exactly what you want visible.
