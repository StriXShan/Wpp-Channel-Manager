import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import {
  checkPassword,
  createSession,
  destroySession,
  hashPassword,
  loadUser,
  requireAdmin,
  requireLogin,
} from './auth.js';
import { stripImageMetadata } from './images.js';
import { newSecret, setupQr, verifyCode } from './totp.js';
import { LoginLimiter, sameOrigin, securityHeaders } from './security.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const STATUS_LABELS = {
  scheduled: 'Programada',
  sending: 'Enviando',
  sent: 'Publicada',
  failed: 'Falló',
  cancelled: 'Cancelada',
};
const TYPE_LABELS = { text: 'Texto', image: 'Imagen', poll: 'Encuesta' };
const NUMBER_STATES = {
  open: 'Conectado',
  qr: 'Esperando escaneo',
  connecting: 'Conectando…',
  unlinked: 'Sin vincular',
};

export function createApp({ db, wa, config }) {
  const app = express();
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadsDir,
      filename: (req, file, cb) => {
        const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '';
        cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
  });

  const dateFmt = new Intl.DateTimeFormat('es-AR', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: config.timezone,
  });
  const dayFmt = new Intl.DateTimeFormat('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone,
  });
  const timeFmt = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: config.timezone });

  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.disable('x-powered-by');
  // Detrás de Caddy o Nginx en el mismo servidor, para ver la IP real.
  app.set('trust proxy', 'loopback');
  app.use(securityHeaders);
  app.use(sameOrigin);
  app.use(express.urlencoded({ extended: false }));
  app.use('/static', express.static(path.join(root, 'public')));
  app.use(loadUser(db));
  app.use((req, res, next) => {
    Object.assign(res.locals, {
      path: req.path,
      STATUS_LABELS,
      TYPE_LABELS,
      NUMBER_STATES,
      fmtDate: (ms) => dateFmt.format(new Date(ms)),
      fmtDay: (ms) => dayFmt.format(new Date(ms)),
      fmtTime: (ms) => timeFmt.format(new Date(ms)),
      toInput: (ms) => {
        if (!ms) return '';
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      },
      flash: req.query.ok || null,
      flashError: req.query.err || null,
    });
    next();
  });

  const hasUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  const back = (res, url, msg, isError = false) =>
    res.redirect(`${url}${url.includes('?') ? '&' : '?'}${isError ? 'err' : 'ok'}=${encodeURIComponent(msg)}`);

  // ---------- Primer uso y sesión ----------

  app.get('/setup', (req, res) => {
    if (hasUsers()) return res.redirect('/login');
    res.render('setup', { error: null });
  });

  // El código de instalación evita que alguien que entre antes al servidor
  // recién instalado se cree el primer administrador.
  const setupTokenOk = (given) => {
    const a = Buffer.from(String(given || '').trim());
    const b = Buffer.from(config.setupToken || '');
    return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  app.post('/setup', (req, res) => {
    if (hasUsers()) return res.redirect('/login');
    if (!setupTokenOk(req.body.setup_token)) {
      return res.status(403).render('setup', { error: 'El código de instalación no es correcto. Lo encontrás en los registros del servidor.' });
    }
    const { username, password } = req.body;
    if (!username || !password || password.length < 8) {
      return res.render('setup', { error: 'Completá todos los campos. La contraseña necesita al menos 8 caracteres.' });
    }
    const r = db
      .prepare("INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
      .run(username.trim().toLowerCase(), username.trim().toLowerCase(), hashPassword(password), Date.now());
    createSession(db, res, r.lastInsertRowid, config.secureCookies);
    res.redirect('/numbers');
  });

  app.get('/login', (req, res) => {
    if (!hasUsers()) return res.redirect('/setup');
    if (req.user) return res.redirect('/');
    res.render('login', { error: null });
  });

  const limiter = new LoginLimiter();

  app.post('/login', (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    if (limiter.isBlocked(req.ip, username)) {
      return res.status(429).render('login', { error: 'Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !checkPassword(String(req.body.password || ''), user.password_hash)) {
      limiter.fail(req.ip, username);
      return res.status(401).render('login', { error: 'Usuario o contraseña incorrectos.' });
    }
    limiter.reset(req.ip, username);
    if (user.totp_secret) {
      // Contraseña correcta: falta el código de la app de verificación.
      const token = crypto.randomBytes(24).toString('hex');
      pending2fa.set(token, { userId: user.id, username, expires: Date.now() + 5 * 60000 });
      return res.render('login-2fa', { token, error: null });
    }
    createSession(db, res, user.id, config.secureCookies);
    res.redirect('/');
  });

  const pending2fa = new Map();

  app.post('/login/2fa', (req, res) => {
    const token = String(req.body.token || '');
    const p = pending2fa.get(token);
    if (!p || p.expires < Date.now()) {
      pending2fa.delete(token);
      return res.status(401).render('login', { error: 'Pasó demasiado tiempo. Ingresá de nuevo.' });
    }
    if (limiter.isBlocked(req.ip, p.username)) {
      pending2fa.delete(token);
      return res.status(429).render('login', { error: 'Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.' });
    }
    const user = db.prepare('SELECT id, totp_secret FROM users WHERE id = ?').get(p.userId);
    if (!user?.totp_secret || !verifyCode(user.totp_secret, req.body.code)) {
      limiter.fail(req.ip, p.username);
      return res.status(401).render('login-2fa', { token, error: 'Código incorrecto. Fijate que la hora del celular esté bien.' });
    }
    pending2fa.delete(token);
    limiter.reset(req.ip, p.username);
    createSession(db, res, user.id, config.secureCookies);
    res.redirect('/');
  });

  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  // ---------- Mi cuenta ----------

  const accountData = (req) => db.prepare('SELECT id, username, totp_secret FROM users WHERE id = ?').get(req.user.id);

  app.get('/account', requireLogin, async (req, res) => {
    const me = accountData(req);
    let setup = null;
    if (!me.totp_secret) {
      const secret = newSecret();
      setup = { secret, qr: await setupQr(secret, me.username) };
    }
    res.render('account', { has2fa: Boolean(me.totp_secret), setup, error: null });
  });

  app.post('/account/2fa/enable', requireLogin, async (req, res) => {
    const secret = String(req.body.secret || '');
    if (!/^[A-Z2-7]{32}$/.test(secret) || !verifyCode(secret, req.body.code)) {
      const me = accountData(req);
      return res.status(400).render('account', {
        has2fa: false,
        setup: { secret, qr: await setupQr(secret, me.username) },
        error: 'El código no coincide. Probá con el siguiente que muestre la app.',
      });
    }
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, req.user.id);
    back(res, '/account', 'Verificación en dos pasos activada.');
  });

  app.post('/account/2fa/disable', requireLogin, (req, res) => {
    const me = accountData(req);
    if (!me.totp_secret || !verifyCode(me.totp_secret, req.body.code)) {
      return back(res, '/account', 'Código incorrecto.', true);
    }
    db.prepare('UPDATE users SET totp_secret = NULL WHERE id = ?').run(req.user.id);
    back(res, '/account', 'Verificación en dos pasos desactivada.');
  });

  app.post('/account/password', requireLogin, (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const next = String(req.body.new_password || '');
    if (!checkPassword(String(req.body.current_password || ''), row.password_hash)) {
      return back(res, '/account', 'La contraseña actual no es correcta.', true);
    }
    if (next.length < 8) return back(res, '/account', 'La nueva contraseña necesita al menos 8 caracteres.', true);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    back(res, '/account', 'Contraseña cambiada.');
  });

  app.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.redirect('/login');
  });

  app.get('/', requireLogin, (req, res) => res.redirect('/posts'));

  app.get('/uploads/:file', requireLogin, (req, res) => {
    const file = path.basename(req.params.file);
    res.sendFile(path.join(config.uploadsDir, file), (err) => err && res.status(404).end());
  });

  // ---------- Publicaciones ----------

  const channelOptions = () =>
    db
      .prepare(
        `SELECT c.id, c.name, n.label AS number_label, n.id AS number_id FROM channels c
         JOIN numbers n ON n.id = c.number_id ORDER BY n.label, c.name`
      )
      .all();

  const canEdit = (user, post) => user.role === 'admin' || post.created_by === user.id;

  const getPost = (id) =>
    db
      .prepare(
        `SELECT p.*, c.name AS channel_name, c.number_id, n.label AS number_label, u.username AS author
         FROM posts p JOIN channels c ON c.id = p.channel_id JOIN numbers n ON n.id = c.number_id
         LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`
      )
      .get(id);

  app.get('/posts', requireLogin, (req, res) => {
    const view = ['upcoming', 'history', 'all'].includes(req.query.view) ? req.query.view : 'upcoming';
    const q = String(req.query.q || '').trim();
    const where = [];
    const args = [];
    if (view === 'upcoming') where.push("p.status IN ('scheduled', 'sending')");
    if (view === 'history') where.push("p.status IN ('sent', 'failed', 'cancelled')");
    if (req.user.role !== 'admin') {
      where.push('p.created_by = ?');
      args.push(req.user.id);
    } else if (req.query.author) {
      where.push('p.created_by = ?');
      args.push(Number(req.query.author));
    }
    if (req.query.channel) {
      where.push('p.channel_id = ?');
      args.push(Number(req.query.channel));
    }
    if (q) {
      where.push('p.text LIKE ?');
      args.push(`%${q}%`);
    }
    const order = view === 'upcoming' ? 'p.scheduled_at ASC' : 'COALESCE(p.sent_at, p.scheduled_at) DESC';
    const posts = db
      .prepare(
        `SELECT p.*, c.name AS channel_name, n.label AS number_label, u.username AS author
         FROM posts p JOIN channels c ON c.id = p.channel_id JOIN numbers n ON n.id = c.number_id
         LEFT JOIN users u ON u.id = p.created_by
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 300`
      )
      .all(...args)
      .map((p) => ({ ...p, poll_values: p.poll_options ? JSON.parse(p.poll_options) : [] }));

    const failedCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM posts WHERE status = 'failed' ${req.user.role === 'admin' ? '' : 'AND created_by = ?'}`
      )
      .get(...(req.user.role === 'admin' ? [] : [req.user.id])).n;

    res.render('posts', {
      view,
      q,
      posts,
      failedCount,
      channels: channelOptions(),
      authors: req.user.role === 'admin' ? db.prepare('SELECT id, username FROM users ORDER BY username').all() : [],
      filters: { author: req.query.author || '', channel: req.query.channel || '' },
      canEdit: (p) => canEdit(req.user, p),
    });
  });

  const emptyPost = () => ({
    id: null, channel_id: '', type: 'text', text: '', image_path: null, poll_values: ['', ''], poll_multi: 0,
    scheduled_at: null,
  });

  app.get('/posts/new', requireLogin, (req, res) => {
    let post = emptyPost();
    const from = req.query.from && getPost(Number(req.query.from));
    if (from && canEdit(req.user, from)) {
      // Duplicar: copia el contenido, pero el horario se elige de nuevo.
      post = { ...from, id: null, scheduled_at: null, poll_values: from.poll_options ? JSON.parse(from.poll_options) : ['', ''] };
    }
    res.render('post-form', { post, channels: channelOptions(), error: null, duplicated: Boolean(from) });
  });

  function readPostForm(req, existing) {
    const b = req.body;
    const type = ['text', 'image', 'poll'].includes(b.type) ? b.type : 'text';
    const text = String(b.text || '').trim();
    const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(Number(b.channel_id));
    const when = b.scheduled_at ? new Date(b.scheduled_at).getTime() : NaN;
    const pollValues = String(b.poll_options || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    let imagePath = existing?.image_path || null;
    if (req.file) imagePath = req.file.filename;
    else if (b.keep_image) imagePath = path.basename(b.keep_image);
    if (!req.file && b.remove_image) imagePath = null;

    const post = {
      ...(existing || {}),
      channel_id: channel?.id || '',
      type,
      text,
      image_path: type === 'image' || type === 'poll' ? imagePath : null,
      poll_options: type === 'poll' ? JSON.stringify(pollValues) : null,
      poll_values: pollValues.length ? pollValues : ['', ''],
      poll_multi: type === 'poll' && b.poll_multi && b.poll_kind !== 'quiz' ? 1 : 0,
      poll_correct: null,
      scheduled_at: Number.isNaN(when) ? null : when,
    };

    let error = null;
    if (!channel) error = 'Elegí un canal.';
    else if (Number.isNaN(when)) error = 'Elegí día y hora.';
    else if (type === 'text' && !text) error = 'Escribí el texto de la publicación.';
    else if (type === 'image' && !post.image_path) error = 'Subí una imagen (JPG, PNG o WEBP, hasta 10 MB).';
    else if (type === 'poll' && !text) error = 'Escribí la pregunta de la encuesta.';
    else if (type === 'poll' && (pollValues.length < 2 || pollValues.length > 12)) {
      error = 'La encuesta necesita entre 2 y 12 opciones, una por renglón.';
    } else if (type === 'poll' && new Set(pollValues).size !== pollValues.length) {
      error = 'Las opciones de la encuesta no pueden repetirse.';
    }
    if (type === 'poll' && b.poll_kind === 'quiz') {
      const correct = pollValues.indexOf(String(b.poll_correct || '').trim());
      if (correct >= 0) post.poll_correct = correct;
      else if (!error) error = 'Elegí cuál es la respuesta correcta del cuestionario.';
    }
    return { post, error };
  }

  const publishNow = (b) => b.action === 'now';

  // Limpia los datos ocultos de la imagen recién subida (ubicación, celular, etc.).
  const cleanUpload = async (req, res, next) => {
    if (!req.file) return next();
    try {
      await stripImageMetadata(req.file.path, req.file.mimetype);
      next();
    } catch {
      await fs.promises.unlink(req.file.path).catch(() => {});
      req.file = null;
      back(res, req.originalUrl === '/posts' ? '/posts/new' : `/posts`, 'No se pudo leer la imagen. Probá con otro archivo.', true);
    }
  };

  app.post('/posts', requireLogin, upload.single('image'), cleanUpload, (req, res) => {
    if (publishNow(req.body)) req.body.scheduled_at = new Date().toISOString();
    const { post, error } = readPostForm(req);
    if (error) return res.status(400).render('post-form', { post, channels: channelOptions(), error, duplicated: false });
    const now = Date.now();
    db.prepare(
      `INSERT INTO posts (channel_id, type, text, image_path, poll_options, poll_multi, poll_correct, scheduled_at, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`
    ).run(post.channel_id, post.type, post.text, post.image_path, post.poll_options, post.poll_multi, post.poll_correct, post.scheduled_at, req.user.id, now, now);
    back(res, '/posts', publishNow(req.body) ? 'Publicación enviada a la cola. Sale en unos segundos.' : 'Publicación programada.');
  });

  const editable = (p) => ['scheduled', 'failed', 'cancelled'].includes(p.status);

  function loadOwnPost(req, res) {
    const post = getPost(Number(req.params.id));
    if (!post || !canEdit(req.user, post)) {
      res.status(404).render('error', { message: 'No se encontró la publicación.' });
      return null;
    }
    return post;
  }

  app.get('/posts/:id/edit', requireLogin, (req, res) => {
    const post = loadOwnPost(req, res);
    if (!post) return;
    if (!editable(post)) return back(res, '/posts?view=history', 'Esta publicación ya salió. Podés duplicarla.', true);
    post.poll_values = post.poll_options ? JSON.parse(post.poll_options) : ['', ''];
    res.render('post-form', { post, channels: channelOptions(), error: null, duplicated: false });
  });

  app.post('/posts/:id', requireLogin, upload.single('image'), cleanUpload, (req, res) => {
    const existing = loadOwnPost(req, res);
    if (!existing) return;
    if (!editable(existing)) return back(res, '/posts', 'Esta publicación ya salió y no se puede editar.', true);
    if (publishNow(req.body)) req.body.scheduled_at = new Date().toISOString();
    const { post, error } = readPostForm(req, existing);
    if (error) return res.status(400).render('post-form', { post, channels: channelOptions(), error, duplicated: false });
    db.prepare(
      `UPDATE posts SET channel_id = ?, type = ?, text = ?, image_path = ?, poll_options = ?, poll_multi = ?, poll_correct = ?,
       scheduled_at = ?, status = 'scheduled', error = NULL, updated_at = ? WHERE id = ? AND status != 'sending'`
    ).run(post.channel_id, post.type, post.text, post.image_path, post.poll_options, post.poll_multi, post.poll_correct, post.scheduled_at, Date.now(), existing.id);
    back(res, '/posts', 'Cambios guardados.');
  });

  app.post('/posts/:id/cancel', requireLogin, (req, res) => {
    const post = loadOwnPost(req, res);
    if (!post) return;
    db.prepare("UPDATE posts SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'scheduled'").run(Date.now(), post.id);
    back(res, '/posts', 'Publicación cancelada.');
  });

  app.post('/posts/:id/delete', requireLogin, (req, res) => {
    const post = loadOwnPost(req, res);
    if (!post) return;
    if (post.status === 'sending') return back(res, '/posts', 'Se está enviando en este momento.', true);
    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
    back(res, req.get('referer')?.includes('history') ? '/posts?view=history' : '/posts', 'Publicación borrada.');
  });

  // ---------- Números y canales (administrador) ----------

  app.get('/numbers', requireAdmin, (req, res) => {
    const numbers = db.prepare('SELECT * FROM numbers ORDER BY label').all().map((n) => ({
      ...n,
      status: wa.status(n.id),
      channels: db.prepare('SELECT * FROM channels WHERE number_id = ? ORDER BY name').all(n.id),
    }));
    res.render('numbers', { numbers });
  });

  app.post('/numbers', requireAdmin, async (req, res) => {
    const label = String(req.body.label || '').trim();
    if (!label) return back(res, '/numbers', 'Poné un nombre para reconocer el número.', true);
    const r = db.prepare('INSERT INTO numbers (label, created_at) VALUES (?, ?)').run(label, Date.now());
    res.redirect(`/numbers/${r.lastInsertRowid}/link`);
  });

  const getNumber = (id) => db.prepare('SELECT * FROM numbers WHERE id = ?').get(Number(id));

  app.get('/numbers/:id/link', requireAdmin, async (req, res) => {
    const number = getNumber(req.params.id);
    if (!number) return res.status(404).render('error', { message: 'No existe ese número.' });
    await wa.startLink(number.id).catch((err) => console.error(err));
    res.render('link', { number });
  });

  app.get('/numbers/:id/status', requireAdmin, (req, res) => {
    const number = getNumber(req.params.id);
    if (!number) return res.status(404).json({});
    res.json({ ...wa.status(number.id), phone: getNumber(number.id).phone });
  });

  app.post('/numbers/:id/logout', requireAdmin, async (req, res) => {
    const number = getNumber(req.params.id);
    if (number) await wa.logout(number.id);
    back(res, '/numbers', 'Se desvinculó el número. Sus canales y publicaciones quedan guardados.');
  });

  app.post('/numbers/:id/delete', requireAdmin, async (req, res) => {
    const number = getNumber(req.params.id);
    if (number) {
      await wa.logout(number.id);
      db.prepare('DELETE FROM numbers WHERE id = ?').run(number.id);
    }
    back(res, '/numbers', 'Número borrado.');
  });

  app.post('/numbers/:id/channels', requireAdmin, async (req, res) => {
    const number = getNumber(req.params.id);
    if (!number) return res.status(404).render('error', { message: 'No existe ese número.' });
    try {
      const ch = await wa.resolveChannel(number.id, req.body.link);
      db.prepare(
        `INSERT INTO channels (number_id, jid, name, invite, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (number_id, jid) DO UPDATE SET name = excluded.name, invite = excluded.invite`
      ).run(number.id, ch.jid, ch.name, ch.invite, Date.now());
      back(res, '/numbers', `Canal "${ch.name}" agregado.`);
    } catch (err) {
      back(res, '/numbers', err.message, true);
    }
  });

  app.post('/channels/:id/delete', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM channels WHERE id = ?').run(Number(req.params.id));
    back(res, '/numbers', 'Canal quitado del panel (y sus publicaciones).');
  });

  // ---------- Usuarios (administrador) ----------

  app.get('/users', requireAdmin, (req, res) => {
    const users = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.totp_secret IS NOT NULL AS has2fa,
         (SELECT COUNT(*) FROM posts p WHERE p.created_by = u.id AND p.status = 'scheduled') AS pending
         FROM users u ORDER BY u.username`
      )
      .all();
    res.render('users', { users });
  });

  app.post('/users', requireAdmin, (req, res) => {
    const { username, password } = req.body;
    const role = req.body.role === 'admin' ? 'admin' : 'editor';
    if (!username || !password || password.length < 8) {
      return back(res, '/users', 'Completá todos los campos. La contraseña necesita al menos 8 caracteres.', true);
    }
    try {
      db.prepare('INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
        username.trim().toLowerCase(), username.trim().toLowerCase(), hashPassword(password), role, Date.now()
      );
    } catch {
      return back(res, '/users', 'Ya existe un usuario con ese nombre de usuario.', true);
    }
    back(res, '/users', 'Usuario creado.');
  });

  app.post('/users/:id/password', requireAdmin, (req, res) => {
    const password = String(req.body.password || '');
    if (password.length < 8) return back(res, '/users', 'La contraseña necesita al menos 8 caracteres.', true);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), Number(req.params.id));
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(req.params.id));
    back(res, '/users', 'Contraseña cambiada.');
  });

  app.post('/users/:id/reset-2fa', requireAdmin, (req, res) => {
    db.prepare('UPDATE users SET totp_secret = NULL WHERE id = ?').run(Number(req.params.id));
    back(res, '/users', 'Se quitó la verificación en dos pasos. La persona puede volver a activarla en "Mi cuenta".');
  });

  app.post('/users/:id/role', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const role = req.body.role === 'admin' ? 'admin' : 'editor';
    if (id === req.user.id) return back(res, '/users', 'No podés cambiar tu propio rol.', true);
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    back(res, '/users', role === 'admin' ? 'Ahora es administrador.' : 'Ahora es de contenidos.');
  });

  app.post('/users/:id/delete', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return back(res, '/users', 'No podés borrar tu propio usuario.', true);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    back(res, '/users', 'Usuario borrado. Sus publicaciones programadas siguen en pie.');
  });

  app.use((req, res) => res.status(404).render('error', { message: 'Página no encontrada.' }));
  app.use((err, req, res, next) => {
    console.error(err);
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'La imagen pesa más de 10 MB.' : 'Algo salió mal. Probá de nuevo.';
    res.status(500).render('error', { message });
  });

  return app;
}
