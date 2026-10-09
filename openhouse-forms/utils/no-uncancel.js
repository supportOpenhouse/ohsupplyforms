// A cancelled property is never un-cancelled — by anyone, from anywhere in the
// supply forms. To bring a lead back, an admin REPLICATES it into a fresh OH ID
// (Admin → Replicate), and the cancelled row stays cancelled.
//
// Why: an un-cancel flips is_dead / is_token_refunded back underneath every
// downstream system. The CRM, for one, copies a cancellation across but never the
// reversal, so the two drift apart (OHND1642 and OHND1207, Oct 2026: live here,
// cancelled in the CRM, with a token refund pending against a deal that had
// moved on). A replicated copy is a new row that every system picks up cleanly.

const UNCANCEL_LOCK_MSG =
  'A cancelled property cannot be un-cancelled. To bring it back, ask an admin to ' +
  'replicate it into a new OH ID (Admin → Replicate).';

module.exports = { UNCANCEL_LOCK_MSG };
