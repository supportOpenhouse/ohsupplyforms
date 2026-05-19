// Authentication & authorization middleware

// Map routes to form names
const ROUTE_FORM_MAP = {
  '/schedule': 'schedule', '/visit': 'visit', '/token-request': 'token-request',
  '/token-deal': 'token-deal', '/ama-details': 'ama-details', '/pending-request': 'pending-request',
  '/final': 'final', '/cp-bill': 'cp-bill', '/listing': 'listing'
};
const API_FORM_MAP = {
  '/api/schedule': 'schedule', '/api/visit': 'visit', '/api/token-request': 'token-request',
  '/api/token-deal': 'token-deal', '/api/ama-details': 'ama-details', '/api/pending-request': 'pending-request',
  '/api/final': 'final', '/api/cp-bill': 'cp-bill', '/api/listing': 'listing'
};

// Check if user is logged in
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  // For API calls, return 401 JSON
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  // For pages, redirect to login with return URL
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

// Check if user has access to a specific form
function hasFormAccess(req, res, next) {
  const user = req.user;
  if (!user || !user.is_active) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Account disabled' });
    return res.redirect('/login?error=disabled');
  }

  // Admins can access everything
  if (user.is_admin) return next();

  // Determine which form this route belongs to
  let formName = null;
  // Check page routes
  for (const [route, form] of Object.entries(ROUTE_FORM_MAP)) {
    if (req.path === route) { formName = form; break; }
  }
  // Check API routes
  if (!formName) {
    for (const [prefix, form] of Object.entries(API_FORM_MAP)) {
      if (req.path.startsWith(prefix)) { formName = form; break; }
    }
  }

  // If not a form route (e.g., /api/config, /api/ocr), allow
  if (!formName) return next();

  // Check if user has wildcard or specific form access
  const forms = user.allowed_forms || [];
  if (forms.includes('*') || forms.includes(formName)) return next();

  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'No access to this form' });
  return res.status(403).send(`
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="stylesheet" href="/css/styles.css"></head>
    <body><header class="hdr centered"><div class="logo">OPENHOUSE</div><div class="logo-sub">Access Denied</div></header>
    <div class="ctn"><div class="card" style="text-align:center;padding:30px">
      <div style="font-size:40px;margin-bottom:10px">🔒</div>
      <div class="card-t">No Access</div>
      <div class="card-d" style="margin-top:8px">You don't have permission to access this form.<br>Contact your admin to request access.</div>
      <a href="/" class="btn btn-dark" style="margin-top:14px;display:inline-block">← Back to Home</a>
    </div></div></body></html>`);
}

// Check if user is admin
function isAdmin(req, res, next) {
  if (req.user && req.user.is_admin) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin access required' });
  return res.status(403).send(`
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="stylesheet" href="/css/styles.css"></head>
    <body><header class="hdr centered"><div class="logo">OPENHOUSE</div><div class="logo-sub">Admin Only</div></header>
    <div class="ctn"><div class="card" style="text-align:center;padding:30px">
      <div style="font-size:40px;margin-bottom:10px">🔐</div>
      <div class="card-t">Admin Access Required</div>
      <div class="card-d" style="margin-top:8px">This page is restricted to administrators.</div>
      <a href="/" class="btn btn-dark" style="margin-top:14px;display:inline-block">← Back to Home</a>
    </div></div></body></html>`);
}

// View-only access to the admin dashboard. Admins pass through; non-admins need 'admin_p' in allowed_forms.
function hasAdminPanelAccess(req, res, next) {
  const u = req.user;
  if (!u || !u.is_active) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Account disabled' });
    return res.redirect('/login?error=disabled');
  }
  if (u.is_admin) return next();
  const forms = u.allowed_forms || [];
  if (forms.includes('*') || forms.includes('admin_p')) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'No access to admin panel' });
  return res.status(403).send(`
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="stylesheet" href="/css/styles.css"></head>
    <body><header class="hdr centered"><div class="logo">OPENHOUSE</div><div class="logo-sub">Access Denied</div></header>
    <div class="ctn"><div class="card" style="text-align:center;padding:30px">
      <div style="font-size:40px;margin-bottom:10px">🔒</div>
      <div class="card-t">No Access</div>
      <div class="card-d" style="margin-top:8px">You don't have permission to view the admin dashboard.</div>
      <a href="/" class="btn btn-dark" style="margin-top:14px;display:inline-block">← Back to Home</a>
    </div></div></body></html>`);
}

module.exports = { isAuthenticated, hasFormAccess, isAdmin, hasAdminPanelAccess };