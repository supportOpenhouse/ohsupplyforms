// Once the AMA is signed, a property can no longer be cancelled from the supply
// forms — not by the Cancel Post Token button, not by the visit-cancel routes, and
// not by the admin edit checkboxes.
//
// Why: after the AMA is executed the deal is live in the Transaction Management
// Dashboard (seller money moving, the unit listed on the Demand Dashboard). A cancel
// from here flips is_token_refunded / is_dead underneath all of that, and the CRM's
// board sync then marks the deal cancelled one-way, with no audit line — exactly how
// OHND1432 ended up wrongly cancelled on 20 Sep 2026. A post-AMA cancellation is a
// different, deliberate decision and is recorded in the CRM ("Cancelled Post AMA").
//
// "Signed" is the UNION of what each side treats as signed, so neither can slip
// through: the CRM counts the executed AMA document or its date; the supply stage
// counts the Pending Amount Request (Form 6); and every later stage implies it.
// Units like OHND1719 — AMA executed and dated, but Form 6 not yet sent, so supply
// still shows "AMA Req" — are signed for this purpose.
//
// Only CANCELLING is blocked. Undoing an existing cancellation stays allowed (it is
// how a wrong cancel gets corrected), subject to the routes' own rules.

function amaSigned(p) {
  if (!p) return false;
  return !!(
    String(p.signed_ama_url || '').trim() ||
    p.ama_date ||
    p.pending_request_submitted_at ||
    p.cp_bill_submitted_at ||
    p.listing_submitted_at ||
    p.final_submitted_at
  );
}

const AMA_LOCK_MSG =
  'The AMA is signed — this property can no longer be cancelled from the supply forms. ' +
  'Record a post-AMA cancellation in the Transaction Management Dashboard instead.';

module.exports = { amaSigned, AMA_LOCK_MSG };
