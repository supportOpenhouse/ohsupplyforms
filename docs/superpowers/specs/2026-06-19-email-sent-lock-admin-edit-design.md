# Email Sent Lock from Admin Edits — Design

**Date:** 2026-06-19
**Status:** Approved

## Problem

Each email stage has a `*_email_sent` boolean column on `properties`. The send-email
route for that stage refuses to send when the flag is `TRUE` (returns
`409 Email Sent Already`) and sets it `TRUE` after a successful send. Admins cannot
currently control these flags: the admin-edit endpoint (`POST /api/admin/property/:uid`)
only persists fields in its `allowed` allow-list, and the five `*_email_sent` columns
are not in it.

We want admins to lock (set `TRUE`) or unlock (set `FALSE`) each stage's email flag
directly from the admin edit popup.

## Affected stages / columns

| Modal section            | DB column                    |
|--------------------------|------------------------------|
| Token Request (Form 3)   | `token_request_email_sent`   |
| Deal Terms (Form 4)      | `token_deal_email_sent`      |
| AMA Ack & Pending (Form 6) | `pending_request_email_sent` |
| CP Bill Generation (Form 8) | `cp_bill_email_sent`      |
| Key Handover (Form 9)    | `final_email_sent`           |

## Design

A plain checkbox labeled **"Email Sent Lock"** in each of the five stage sections of
the admin edit modal. Checked = locked (= email treated as already sent, send blocked).
Unchecked = unlocked (send re-enabled). Saved through the existing **Save Changes**
button — no new endpoint, no confirmation dialog, no separate panel.

### Change 1 — `openhouse-forms/server.js` (admin-edit allow-list)

Add the five column names to the `allowed` Set in the
`POST /api/admin/property/:uid` handler so the values persist. Boolean values from the
client flow through the existing update loop unchanged, and `logAdminEdit` already
records any change to these fields in the audit log.

### Change 2 — `openhouse-forms/public/admin.html` (`buildModal`)

Render an `"Email Sent Lock"` checkbox in each of the five sections, with
`name="<column>"` and `${p.<column> ? 'checked' : ''}`. The existing `saveModal`
collector already serializes checkboxes as booleans and POSTs them, so no save-path
change is needed.

## Out of scope / non-goals

- No DB migration — all five columns already exist.
- No changes to the five send-email routes.
- No access restriction beyond the existing `isAdmin` gate on the endpoint.
- No unlock confirmation prompt.

## Access control

Same gate as all other admin edits (`isAuthenticated, isAdmin`). Any admin who can edit
the property can toggle the locks.

## Verification

- Server allow-list: a POST containing `token_request_email_sent: true` updates the row;
  the same field at `false` clears it.
- Modal round-trip: opening a property whose flag is `TRUE` renders the box checked;
  toggling and saving persists and re-renders correctly.
- Send-email guard still honors the flag (unchanged behavior).
