/** Encabezados básicos para que el navegador no permita usos raros del panel. */
export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  });
  next();
}

/**
 * Rechaza formularios enviados desde otro sitio (CSRF): los navegadores mandan
 * el origen en cada POST, y tiene que coincidir con el del panel.
 */
export function sameOrigin(req, res, next) {
  if (req.method !== 'POST') return next();
  const source = req.get('origin') || req.get('referer');
  if (!source) return next();
  try {
    if (new URL(source).host === req.get('host')) return next();
  } catch {}
  res.status(403).send('Formulario rechazado: no viene del panel.');
}

/** Bloquea por un rato después de varios intentos de login fallidos. */
export class LoginLimiter {
  constructor({ maxFailures = 5, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    Object.assign(this, { maxFailures, windowMs, now });
    this.failures = new Map();
  }

  key(ip, username) {
    return `${ip}|${username}`;
  }

  recent(key) {
    const list = (this.failures.get(key) || []).filter((t) => this.now() - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  isBlocked(ip, username) {
    return this.recent(this.key(ip, username)).length >= this.maxFailures
      || this.recent(this.key(ip, '*')).length >= this.maxFailures * 4;
  }

  fail(ip, username) {
    for (const k of [this.key(ip, username), this.key(ip, '*')]) this.failures.set(k, [...this.recent(k), this.now()]);
  }

  reset(ip, username) {
    this.failures.delete(this.key(ip, username));
  }
}
