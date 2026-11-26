import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Scheduler, buildMessage } from '../src/scheduler.js';

function setup({ connected = true, failSend = false } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO numbers (id, label, created_at) VALUES (1, 'N1', 0)").run();
  db.prepare("INSERT INTO channels (id, number_id, jid, name, created_at) VALUES (1, 1, '123@newsletter', 'Canal', 0)").run();
  const sent = [];
  const wa = {
    isConnected: () => connected,
    send: async (numberId, jid, content) => {
      if (failSend) throw new Error('boom');
      sent.push({ numberId, jid, content });
    },
  };
  let now = 1_000_000;
  const scheduler = new Scheduler({ db, wa, uploadsDir: '/up', gapMs: 0, now: () => now });
  const addPost = (fields) =>
    db
      .prepare(
        `INSERT INTO posts (channel_id, type, text, image_path, poll_options, poll_multi, scheduled_at, status, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, 'scheduled', 0, 0)`
      )
      .run(fields.type || 'text', fields.text || 'hola', fields.image_path || null, fields.poll_options || null, fields.poll_multi || 0, fields.at).lastInsertRowid;
  const status = (id) => db.prepare('SELECT status, error FROM posts WHERE id = ?').get(id);
  return { db, sent, scheduler, addPost, status, setNow: (v) => (now = v) };
}

test('publica solo lo que ya venció, en orden', async () => {
  const t = setup();
  const later = t.addPost({ at: 2_000_000, text: 'después' });
  const b = t.addPost({ at: 900_000, text: 'segundo' });
  const a = t.addPost({ at: 800_000, text: 'primero' });
  await t.scheduler.tick();
  assert.deepEqual(t.sent.map((s) => s.content.text), ['primero', 'segundo']);
  assert.equal(t.status(a).status, 'sent');
  assert.equal(t.status(b).status, 'sent');
  assert.equal(t.status(later).status, 'scheduled');
  await t.scheduler.tick();
  assert.equal(t.sent.length, 2, 'no repite publicaciones ya enviadas');
});

test('si el número está desconectado espera y después marca como fallida', async () => {
  const t = setup({ connected: false });
  const id = t.addPost({ at: 1_000_000 });
  await t.scheduler.tick();
  assert.equal(t.status(id).status, 'scheduled');
  t.setNow(1_000_000 + 16 * 60000);
  await t.scheduler.tick();
  assert.equal(t.status(id).status, 'failed');
  assert.match(t.status(id).error, /desconectado/);
});

test('un error al enviar queda registrado', async () => {
  const t = setup({ failSend: true });
  const id = t.addPost({ at: 1 });
  await t.scheduler.tick();
  assert.equal(t.status(id).status, 'failed');
  assert.match(t.status(id).error, /boom/);
});

test('arma los mensajes de imagen y encuesta', () => {
  assert.deepEqual(buildMessage({ type: 'image', text: 'pie', image_path: 'a.jpg' }, '/up'), {
    image: { url: '/up/a.jpg' },
    caption: 'pie',
  });
  assert.deepEqual(buildMessage({ type: 'poll', text: '¿Qué preferís?', poll_options: '["A","B","C"]', poll_multi: 0 }, '/up'), {
    poll: { name: '¿Qué preferís?', values: ['A', 'B', 'C'], selectableCount: 1 },
  });
});
