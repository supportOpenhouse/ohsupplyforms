const express = require('express');
const passport = require('passport');
const router = express.Router();
const { isAuthenticated, isAdmin } = require('../middleware/auth');

const SUPER_EMAIL = 'sahaj.dureja@openhouse.in';
function isSuperUser(req, res, next) {
  if (req.user && (req.user.email || '').toLowerCase() === SUPER_EMAIL) return next();
  return res.status(403).json({ error: 'Only the super user can manage users' });
}

module.exports = function(pool) {

  // ── Google OAuth — includes Gmail send scope ──
  router.get('/google', (req, res, next) => {
    if (req.query.returnTo) req.session.returnTo = req.query.returnTo;
    passport.authenticate('google', {
      scope: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'],
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
    res.json({ email: u.email, name: u.name, allowed_forms: u.allowed_forms, is_admin: u.is_admin, is_manager: u.is_manager });
  });

  // ── Admin: list all users ──
  router.get('/users', isAuthenticated, isAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT id,email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit,is_active,created_at FROM users ORDER BY name ASC');
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: add user (super user only) ──
  router.post('/users', isAuthenticated, isAdmin, isSuperUser, async (req, res) => {
    try {
      const { email, name, phone, allowed_forms, is_admin, is_manager, is_top_manager, can_assign, can_visit } = req.body;
      if (!email) return res.status(400).json({ error: 'Email required' });
      const forms = allowed_forms || [];
      const { rows } = await pool.query(
        `INSERT INTO users(email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit)
         VALUES(LOWER($1),$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(email) DO UPDATE SET name=$2,phone=COALESCE(NULLIF($3,''),users.phone),allowed_forms=$4,is_admin=$5,is_manager=$6,is_top_manager=$7,can_assign=$8,can_visit=$9,is_active=TRUE
         RETURNING id,email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit,is_active`,
        [email.trim(), name || '', phone || null, forms, is_admin || false, is_manager || false, is_top_manager || false, can_assign || false, can_visit || false]
      );
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: update user (super user only) ──
  router.put('/users/:id', isAuthenticated, isAdmin, isSuperUser, async (req, res) => {
    try {
      const { name, phone, allowed_forms, is_admin, is_manager, is_top_manager, can_assign, can_visit, is_active } = req.body;
      const { rows } = await pool.query(
        `UPDATE users SET name=COALESCE($1,name),phone=COALESCE($7,phone),allowed_forms=COALESCE($2,allowed_forms),
         is_admin=COALESCE($3,is_admin),is_manager=COALESCE($6,is_manager),is_top_manager=COALESCE($8,is_top_manager),
         can_assign=COALESCE($9,can_assign),can_visit=COALESCE($10,can_visit),is_active=COALESCE($4,is_active) WHERE id=$5
         RETURNING id,email,name,phone,allowed_forms,is_admin,is_manager,is_top_manager,can_assign,can_visit,is_active`,
        [name, allowed_forms, is_admin, is_active, req.params.id, is_manager, phone, is_top_manager, can_assign, can_visit]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: delete user (super user only) ──
  router.delete('/users/:id', isAuthenticated, isAdmin, isSuperUser, async (req, res) => {
    try {
      await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
