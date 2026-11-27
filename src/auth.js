import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const SESSION_DAYS = 30;
const COOKIE = 'sid';

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

export function checkPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(db, res, userId, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  });
}

export function currentSession(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || '';
}

export function destroySession(db, req, res) {
  const token = currentSession(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE);
}

/** Carga req.user a partir de la cookie de sesión. */
export function loadUser(db) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = null;
    if (token) {
      const row = db
        .prepare(
          `SELECT u.id, u.username, u.name, u.role FROM sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.token = ? AND s.expires_at > ?`
        )
        .get(token, Date.now());
      if (row) req.user = { ...row };
    }
    res.locals.user = req.user;
    next();
  };
}

export function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.status(403).render('error', { message: 'Solo un administrador puede ver esta sección.' });
  next();
}
