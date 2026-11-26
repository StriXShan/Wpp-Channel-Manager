import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Arma los mensajes de WhatsApp de una publicación. Casi siempre es uno solo;
 * una encuesta con imagen son dos seguidos: primero la imagen y abajo la encuesta.
 * `raw` indica un mensaje armado a mano (cuestionario), que no tiene atajo en Baileys.
 */
export function buildMessages(post, uploadsDir) {
  if (post.type === 'text') return [{ label: 'el texto', content: { text: post.text } }];
  if (post.type === 'image') {
    return [{ label: 'la imagen', content: { image: { url: path.join(uploadsDir, post.image_path) }, caption: post.text || undefined } }];
  }
  if (post.type === 'poll') {
    const values = JSON.parse(post.poll_options || '[]');
    const steps = [];
    if (post.image_path) {
      steps.push({ label: 'la imagen', content: { image: { url: path.join(uploadsDir, post.image_path) } } });
    }
    if (post.poll_correct !== null && post.poll_correct !== undefined) {
      steps.push({
        label: 'el cuestionario',
        raw: true,
        content: {
          messageContextInfo: { messageSecret: crypto.randomBytes(32) },
          pollCreationMessageV5: {
            name: post.text,
            options: values.map((optionName) => ({ optionName })),
            selectableOptionsCount: 1,
            pollType: 1, // QUIZ
            correctAnswer: { optionName: values[post.poll_correct] },
          },
        },
      });
    } else {
      // selectableCount 0 = se pueden elegir varias opciones.
      steps.push({ label: 'la encuesta', content: { poll: { name: post.text, values, selectableCount: post.poll_multi ? 0 : 1 } } });
    }
    return steps;
  }
  throw new Error(`Tipo de publicación desconocido: ${post.type}`);
}

/**
 * Revisa cada tantos segundos si hay publicaciones cuyo horario ya llegó y las
 * envía de a una, con una pausa entre envíos para no parecer un bot.
 */
export class Scheduler {
  constructor({ db, wa, uploadsDir, maxDelayMinutes = 15, gapMs = 4000, now = () => Date.now() }) {
    Object.assign(this, { db, wa, uploadsDir, maxDelayMinutes, gapMs, now });
    this.running = false;
  }

  start(intervalMs) {
    this.timer = setInterval(() => this.tick().catch((err) => console.error('scheduler', err)), intervalMs);
    this.tick().catch((err) => console.error('scheduler', err));
  }

  stop() {
    clearInterval(this.timer);
  }

  duePosts() {
    return this.db
      .prepare(
        `SELECT p.*, c.jid, c.number_id FROM posts p
         JOIN channels c ON c.id = p.channel_id
         WHERE p.status = 'scheduled' AND p.scheduled_at <= ?
         ORDER BY p.scheduled_at, p.id`
      )
      .all(this.now());
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      let first = true;
      for (const post of this.duePosts()) {
        const lateMs = this.now() - post.scheduled_at;
        if (!this.wa.isConnected(post.number_id)) {
          if (lateMs > this.maxDelayMinutes * 60000) {
            this.fail(post.id, 'El número estaba desconectado a la hora de publicar.');
          }
          continue; // se reintenta en la próxima vuelta
        }
        if (!first && this.gapMs) await new Promise((r) => setTimeout(r, this.gapMs));
        first = false;
        await this.sendOne(post);
      }
    } finally {
      this.running = false;
    }
  }

  async sendOne(post) {
    // Se marca como "enviando" antes de mandar para no publicar dos veces.
    const claimed = this.db
      .prepare("UPDATE posts SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'scheduled'")
      .run(this.now(), post.id);
    if (claimed.changes === 0) return;
    const done = [];
    try {
      const steps = buildMessages(post, this.uploadsDir);
      for (const [i, step] of steps.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1500));
        try {
          if (step.raw) await this.wa.sendRaw(post.number_id, post.jid, step.content);
          else await this.wa.send(post.number_id, post.jid, step.content);
        } catch (err) {
          err.step = step.label;
          throw err;
        }
        done.push(step.label);
      }
      this.db
        .prepare("UPDATE posts SET status = 'sent', sent_at = ?, error = NULL, updated_at = ? WHERE id = ?")
        .run(this.now(), this.now(), post.id);
    } catch (err) {
      const partial = done.length ? ` Ya se había publicado ${done.join(' y ')}: revisá el canal antes de reintentar.` : '';
      this.fail(post.id, `No se pudo publicar ${err.step || ''}: ${err.message}.${partial}`.replace(/\s+:/, ':'));
    }
  }

  fail(id, message) {
    this.db
      .prepare("UPDATE posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(message, this.now(), id);
  }
}
