const express = require('express');
const passport = require('passport');
const router = express.Router();
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');

// Fields tracked when diffing user updates
const USER_TRACKED_FIELDS = ['name','phone','allowed_forms','is_admin','is_manager','is_top_manager','can_assign','can_visit','is_super','is_active'];

function arrEq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function diffUserFields(oldUser, body) {
  const changes = {};
  for (const f of USER_TRACKED_FIELDS) {
    if (!(f in body)) continue;
    const newVal = body[f];
    if (newVal == null) continue;
    const oldVal = oldUser ? oldUser[f] : null;
    const same = Array.isArray(newVal) ? arrEq(oldVal || [], newVal) : (oldVal === newVal);
    if (!same) changes[f] = { old: oldVal == null ? null : oldVal, new: newVal };
  }
  return changes;
}

function isSuperUser(req, res, next) {
  if (req.user && req.user.is_super) return next();
  return res.status(403).json({ error: 'Only the super user can manage users' });
}

module.exports = function(pool) {

  // ── Google OAuth — includes Gmail send + Calendar scopes ──
  router.get('/google', (req, res, next) => {
    if (req.query.returnTo) req.session.returnTo = req.query.returnTo;
    passport.authenticate('google', {
      scope: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events'],
      accessType: 'offline',
      prompt: 'consent'
    })(req, res, next);
  });

  router.get('/google/callback',
    passport.authenticate('google', { failureRedirect: '/login?error=failed' }),
    (req, res) => {
      const returnTo = req.session.returnTo || '/';
      delete req.session.returnTo;
      res.redirect(returnTo);
    }
  );

  // ── Logout ──
  router.get('/logout', (req, res) => {
    req.logout(() => {
      req.session.destroy(() => { res.redirect('/login'); });
    });
  });

  // ── Current user info ──
  router.get('/me', isAuthenticated, (req, res) => {
    const u = req.user;
    res.json({ email: u.email, name: u.name, allowed_forms: u.allowed_forms, is_admin: u.is_admin, is_manager: u.is_manager, is_super: u.is_super, can_assign: u.can_assign });
  });

  // ── Admin: list all users ──
  router.get('/users', isAuthenticated, isAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT id,email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit,is_super,is_active,created_at FROM users ORDER BY name ASC');
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: add user (super user only) ──
  router.post('/users', isAuthenticated, isAdmin, isSuperUser, async (req, res) => {
    try {
      const { email, name, phone, allowed_forms, is_admin, is_manager, is_top_manager, can_assign, can_visit, is_super } = req.body;
      if (!email) return res.status(400).json({ error: 'Email required' });
      const forms = allowed_forms || [];
      const lowerEmail = email.trim().toLowerCase();
      const existing = await pool.query('SELECT id,email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit,is_super,is_active FROM users WHERE LOWER(email)=$1', [lowerEmail]);
      const { rows } = await pool.query(
        `INSERT INTO users(email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit,is_super)
         VALUES(LOWER($1),$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(email) DO UPDATE SET name=$2,phone=COALESCE(NULLIF($3,''),users.phone),allowed_forms=$4,is_admin=$5,is_manager=$6,is_top_manager=$7,can_assign=$8,can_visit=$9,is_super=$10,is_active=TRUE
         RETURNING id,email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit,is_super,is_active`,
        [email.trim(), name || '', phone || null, forms, is_admin || false, is_manager || false, is_top_manager || false, can_assign || false, can_visit || false, is_super || false]
      );
      res.json(rows[0]);
      const newUser = rows[0];
      if (existing.rows.length) {
        const changes = diffUserFields(existing.rows[0], newUser);
        if (Object.keys(changes).length) logger.logUserChange('user_updated', newUser, changes, req.user?.email, req.user?.name).catch(() => {});
      } else {
        const initial = {};
        for (const f of USER_TRACKED_FIELDS) initial[f] = { old: null, new: newUser[f] };
        logger.logUserChange('user_created', newUser, initial, req.user?.email, req.user?.name).catch(() => {});
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: update user (super user only) ──
  router.put('/users/:id', isAuthenticated, isAdmin, isSuperUser, async (req, res) => {
    try {
      const { name, phone, allowed_forms, is_admin, is_manager, is_top_manager, can_assign, can_visit, is_active, is_super } = req.body;
      const before = await pool.query('SELECT id,email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit,is_super,is_active FROM users WHERE id=$1', [req.params.id]);
      const { rows } = await pool.query(
        `UPDATE users SET name=COALESCE($1,name),phone=COALESCE($7,phone),allowed_forms=COALESCE($2,allowed_forms),
         is_admin=COALESCE($3,is_admin),is_manager=COALESCE($6,is_manager),is_top_manager=COALESCE($8,is_top_manager),
         can_assign=COALESCE($9,can_assign),can_visit=COALESCE($10,can_visit),is_super=COALESCE($11,is_super),is_active=COALESCE($4,is_active) WHERE id=$5
         RETURNING id,email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit,is_super,is_active`,
        [name, allowed_forms, is_admin, is_active, req.params.id, is_manager, phone, is_top_manager, can_assign, can_visit, is_super]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      res.json(rows[0]);
      if (before.rows.length) {
        const changes = diffUserFields(before.rows[0], rows[0]);
        if (Object.keys(changes).length) logger.logUserChange('user_updated', rows[0], changes, req.user?.email, req.user?.name).catch(() => {});
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: delete user (super user only) ──
  router.delete('/users/:id', isAuthenticated, isAdmin, isSuperUser, async (req, res) => {
    try {
      const before = await pool.query('SELECT id,email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit,is_super,is_active FROM users WHERE id=$1', [req.params.id]);
      await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
      res.json({ success: true });
      if (before.rows.length) {
        const snapshot = {};
        for (const f of USER_TRACKED_FIELDS) snapshot[f] = { old: before.rows[0][f], new: null };
        logger.logUserChange('user_deleted', before.rows[0], snapshot, req.user?.email, req.user?.name).catch(() => {});
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
