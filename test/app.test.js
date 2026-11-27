import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { parseChannelInvite } from '../src/whatsapp.js';

process.env.TZ = 'America/Argentina/Buenos_Aires';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wcm-'));
const db = openDb(':memory:');
const wa = {
  status: () => ({ state: 'open' }),
  isConnected: () => true,
  startLink: async () => {},
  logout: async () => {},
  resolveChannel: async () => ({ jid: '999@newsletter', name: 'Canal de prueba', invite: 'ABC' }),
};
const config = { uploadsDir: tmp, timezone: 'America/Argentina/Buenos_Aires', secureCookies: false, setupToken: 'codigo-123' };
const server = createApp({ db, wa, config }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function req(method, url, { body, cookie } = {}) {
  const res = await fetch(base + url, {
    method,
    redirect: 'manual',
    headers: { ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? new URLSearchParams(body) : undefined,
  });
  return { res, text: await res.text(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

test('flujo completo: alta de admin, canal, publicación y permisos', async () => {
  assert.equal((await req('GET', '/posts')).res.headers.get('location'), '/login');
  assert.equal((await req('GET', '/login')).res.headers.get('location'), '/setup');

  const noToken = await req('POST', '/setup', { body: { name: 'Intruso', username: 'x', password: 'secreto123', setup_token: 'otro' } });
  assert.equal(noToken.res.status, 403, 'sin el código de instalación no se crea el admin');
  const setup = await req('POST', '/setup', { body: { name: 'Thiago', username: 'thiago', password: 'secreto123', setup_token: 'codigo-123' } });
  const admin = setup.cookie;
  assert.ok(admin);

  await req('POST', '/numbers', { body: { label: 'Número 1' }, cookie: admin });
  const add = await req('POST', '/numbers/1/channels', { body: { link: 'https://whatsapp.com/channel/ABC' }, cookie: admin });
  assert.match(decodeURIComponent(add.res.headers.get('location')), /Canal de prueba/);

  const bad = await req('POST', '/posts', { body: { channel_id: '1', type: 'poll', text: '¿Sí?', poll_options: 'Solo una', scheduled_at: '2030-01-01T10:00' }, cookie: admin });
  assert.equal(bad.res.status, 400);
  assert.match(bad.text, /entre 2 y 12 opciones/);

  const ok = await req('POST', '/posts', { body: { channel_id: '1', type: 'text', text: 'Hola canal', scheduled_at: '2030-01-01T10:00' }, cookie: admin });
  assert.equal(ok.res.status, 302);
  const post = db.prepare('SELECT * FROM posts').get();
  assert.equal(post.status, 'scheduled');
  assert.equal(new Date(post.scheduled_at).toISOString(), '2030-01-01T13:00:00.000Z', 'hora de Buenos Aires');

  // Una persona de contenidos no ve las publicaciones de otros ni las secciones de administración.
  await req('POST', '/users', { body: { name: 'Ana', username: 'ana', password: 'secreto123', role: 'editor' }, cookie: admin });
  const ana = (await req('POST', '/login', { body: { username: 'ana', password: 'secreto123' } })).cookie;
  assert.doesNotMatch((await req('GET', '/posts', { cookie: ana })).text, /Hola canal/);
  assert.equal((await req('GET', '/numbers', { cookie: ana })).res.status, 403);
  assert.equal((await req('GET', `/posts/${post.id}/edit`, { cookie: ana })).res.status, 404);

  await req('POST', '/posts', { body: { channel_id: '1', type: 'text', text: 'Post de Ana', scheduled_at: '2030-01-02T10:00' }, cookie: ana });
  // Ya hay usuarios: el alta inicial queda cerrada aunque se tenga el código.
  await req('POST', '/setup', { body: { name: 'Otro', username: 'otro', password: 'secreto123', setup_token: 'codigo-123' } });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'otro'").get().n, 0);
  // Contenidos no puede darse rol de administrador.
  const anaId = db.prepare("SELECT id FROM users WHERE username = 'ana'").get().id;
  assert.equal((await req('POST', `/users/${anaId}/role`, { body: { role: 'admin' }, cookie: ana })).res.status, 403);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(anaId).role, 'editor');

  // El administrador ve todo.
  const all = (await req('GET', '/posts', { cookie: admin })).text;
  assert.match(all, /Hola canal/);
  assert.match(all, /Post de Ana/);
});

test('reconoce links de canales', () => {
  assert.equal(parseChannelInvite('https://whatsapp.com/channel/0029VaABCdef123'), '0029VaABCdef123');
  assert.equal(parseChannelInvite('hola'), null);
});

test('verificación en dos pasos al entrar', async () => {
  const { TOTP, Secret } = await import('otpauth');
  const secret = new Secret({ size: 20 }).base32;
  db.prepare("UPDATE users SET totp_secret = ? WHERE username = 'ana'").run(secret);
  const step1 = await req('POST', '/login', { body: { username: 'ana', password: 'secreto123' } });
  assert.equal(step1.cookie, undefined, 'sin código no hay sesión');
  const token = step1.text.match(/name="token" value="([a-f0-9]+)"/)[1];
  const wrong = await req('POST', '/login/2fa', { body: { token, code: '000000' } });
  assert.equal(wrong.res.status, 401);
  const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate();
  const ok = await req('POST', '/login/2fa', { body: { token, code } });
  assert.equal(ok.res.status, 302);
  assert.ok(ok.cookie);
  assert.equal((await req('GET', '/robots.txt')).text, 'User-agent: *\nDisallow: /\n');
});

test('revisión: imagen inventada, horario pasado y publicación ya enviada', async () => {
  const admin = (await req('POST', '/login', { body: { username: 'thiago', password: 'secreto123' } })).cookie;
  // Un nombre de imagen armado a mano no se guarda ni se pinta en la página.
  const evil = 'x" onerror="alert(1)';
  const r = await req('POST', '/posts', { body: { channel_id: '1', type: 'image', keep_image: evil, scheduled_at: '2030-01-03T10:00' }, cookie: admin });
  assert.equal(r.res.status, 400);
  assert.doesNotMatch(r.text, /onerror/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE image_path LIKE ?').get('%onerror%').n, 0);

  // Un horario que ya pasó se rechaza (salvo "Publicar ahora").
  const past = await req('POST', '/posts', { body: { channel_id: '1', type: 'text', text: 'Viejo', scheduled_at: '2020-01-01T10:00' }, cookie: admin });
  assert.equal(past.res.status, 400);
  assert.match(past.text, /ya pasó/);

  // Una publicación que ya salió no vuelve a la cola aunque llegue un formulario viejo.
  const id = db.prepare("SELECT id FROM posts WHERE text = 'Hola canal'").get().id;
  db.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").run(id);
  await req('POST', `/posts/${id}`, { body: { channel_id: '1', type: 'text', text: 'Hola canal', scheduled_at: '2030-01-01T10:00' }, cookie: admin });
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(id).status, 'sent');
});
