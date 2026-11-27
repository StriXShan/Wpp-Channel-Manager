import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { Scheduler, buildMessages } from '../src/scheduler.js';

function setup({ connected = true, failSend = false } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO numbers (id, label, created_at) VALUES (1, 'N1', 0)").run();
  db.prepare("INSERT INTO channels (id, number_id, jid, name, created_at) VALUES (1, 1, '123@newsletter', 'Canal', 0)").run();
  const sent = [];
  const wa = {
    isConnected: () => connected,
    publish: async (numberId, jid, step) => {
      if (failSend) throw new Error('boom');
      sent.push({ numberId, jid, step });
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
  assert.deepEqual(t.sent.map((s) => s.step.text), ['primero', 'segundo']);
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

test('arma los pasos de imagen, encuesta, encuesta con imagen y cuestionario', () => {
  const strip = (post) => buildMessages(post, '/up').map(({ label, ...rest }) => rest);
  assert.deepEqual(strip({ type: 'image', text: 'pie', image_path: 'a.jpg' }), [
    { kind: 'image', filePath: path.join('/up', 'a.jpg'), caption: 'pie' },
  ]);
  assert.deepEqual(strip({ type: 'poll', text: '¿Qué preferís?', poll_options: '["A","B","C"]', poll_multi: 0, poll_correct: null }), [
    { kind: 'poll', name: '¿Qué preferís?', values: ['A', 'B', 'C'], multi: false, correctIndex: null },
  ]);
  const withImage = strip({ type: 'poll', text: '¿Cuál?', image_path: 'b.jpg', poll_options: '["A","B"]', poll_multi: 1, poll_correct: null });
  assert.deepEqual(withImage, [
    { kind: 'image', filePath: path.join('/up', 'b.jpg'), caption: undefined },
    { kind: 'poll', name: '¿Cuál?', values: ['A', 'B'], multi: true, correctIndex: null },
  ]);
  const [quiz] = buildMessages({ type: 'poll', text: '2+2', poll_options: '["3","4"]', poll_correct: 1 }, '/up');
  assert.equal(quiz.label, 'el cuestionario');
  assert.equal(quiz.correctIndex, 1);
});

test('si falla la encuesta después de la imagen, lo avisa', async () => {
  const t = setup();
  let calls = 0;
  t.scheduler.wa.publish = async (n, j, step) => {
    calls++;
    if (step.kind === 'poll') throw new Error('rechazado');
  };
  const id = t.db
    .prepare(
      `INSERT INTO posts (channel_id, type, text, image_path, poll_options, scheduled_at, status, created_at, updated_at)
       VALUES (1, 'poll', '¿Cuál?', 'x.jpg', '["A","B"]', 1, 'scheduled', 0, 0)`
    )
    .run().lastInsertRowid;
  await t.scheduler.tick();
  assert.equal(calls, 2);
  assert.equal(t.status(id).status, 'failed');
  assert.match(t.status(id).error, /No se pudo publicar la encuesta: rechazado\. Ya se había publicado la imagen/);
});
