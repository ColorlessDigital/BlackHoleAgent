import crypto from 'crypto';

export function createSession() {
  return {
    token: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString()
  };
}

// P2-8: ?token is accepted ONLY on /api/events (EventSource cannot send
// headers). Every other endpoint requires the x-blackhole-token header, so
// tokens no longer leak into proxy logs / shell history via query strings.
export function createAuthMiddleware(session) {
  return function authMiddleware(req, res, next) {
    const routePath = `${req.baseUrl || ''}${req.path}`;
    if (routePath === '/api/health' || routePath === '/api/bootstrap') return next();
    const headerToken = req.get('x-blackhole-token');
    if (headerToken && headerToken === session.token) return next();
    if (routePath === '/api/events' && req.query.token === session.token) return next();
    return res.status(401).json({ error: 'BlackHole local session token is missing or invalid.' });
  };
}

export function createCorsMiddleware(allowedOrigins) {
  return function corsMiddleware(req, res, next) {
    const origin = req.get('origin');
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-blackhole-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}
