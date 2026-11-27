import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { generateMessageIDV2, proto } from 'baileys';

/*
 * Envío a canales de WhatsApp (newsletters).
 *
 * Baileys 7.0.0-rc14 manda bien el texto a canales, pero WhatsApp rechaza sus
 * imágenes y encuestas con el error 479 (smax-invalid): las imágenes se suben
 * por la ruta de los chats comunes y al mensaje le faltan atributos que los
 * canales exigen. Acá se arma el mensaje como lo hace WhatsApp Web:
 *
 * - Imagen: se sube sin cifrar a /newsletter/newsletter-image y el mensaje lleva
 *   el `media_id` que devuelve la subida y `mediatype="image"` en el contenido.
 * - Encuesta y cuestionario: llevan `<meta polltype="creation"/>`.
 *
 * Además se espera la confirmación (ack) del servidor: si WhatsApp rechaza el
 * mensaje, el envío falla en vez de quedar marcado como publicado.
 */

const ACK_TIMEOUT_MS = 20000;

/** Espera la confirmación del servidor para el mensaje `id`. */
export function waitForAck(sock, id, timeoutMs = ACK_TIMEOUT_MS) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const onAck = (node) => {
      if (node?.attrs?.id !== id) return;
      cleanup();
      const error = node.attrs.error;
      if (error) {
        const hint = error === '479' ? ' (WhatsApp rechazó el formato del mensaje)' : '';
        reject(new Error(`WhatsApp rechazó la publicación, código ${error}${hint}`));
      } else {
        resolve(node.attrs);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('WhatsApp no confirmó la publicación a tiempo. Revisá el canal antes de reintentar'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      sock.ws.off('CB:ack,class:message', onAck);
    };
    sock.ws.on('CB:ack,class:message', onAck);
    cancel = cleanup;
  });
  // Deja de esperar sin rechazar (para cuando el envío mismo ya falló).
  promise.cancel = cancel;
  return promise;
}

function newId(sock) {
  return generateMessageIDV2(sock.user?.id);
}

/**
 * Manda con `send()` y espera la confirmación del mensaje `id`. La espera se
 * arma antes de mandar para no perder un ack rápido; si el envío falla se
 * cancela, porque si no su rechazo 20 segundos después tumba el proceso.
 */
async function sendAndConfirm(sock, id, send) {
  const ack = waitForAck(sock, id);
  try {
    await send();
  } catch (err) {
    ack.cancel();
    throw err;
  }
  await ack;
  return id;
}

/** Manda un mensaje armado a mano a un canal y espera la confirmación. */
async function sendStanza(sock, jid, message, { type, mediaType, mediaId, extraNodes = [] }) {
  const id = newId(sock);
  const plaintext = { tag: 'plaintext', attrs: mediaType ? { mediatype: mediaType } : {}, content: proto.Message.encode(message).finish() };
  const stanza = {
    tag: 'message',
    attrs: { to: jid, id, type, ...(mediaId ? { media_id: mediaId } : {}) },
    content: [plaintext, ...extraNodes],
  };
  return sendAndConfirm(sock, id, () => sock.sendNode(stanza));
}

/** Sube una imagen para un canal (sin cifrar, como hace WhatsApp Web). */
async function uploadNewsletterImage(sock, buffer) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest();
  const token = sha256.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let lastError;
  for (const force of [false, true]) {
    const conn = await sock.refreshMediaConn(force);
    for (const { hostname } of conn.hosts) {
      try {
        const url = `https://${hostname}/newsletter/newsletter-image/${token}?auth=${encodeURIComponent(conn.auth)}&token=${token}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://web.whatsapp.com' },
          body: buffer,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && (data.url || data.direct_path)) return { ...data, sha256 };
        lastError = new Error(`subida rechazada (${res.status}) ${JSON.stringify(data)}`);
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw new Error(`No se pudo subir la imagen: ${lastError?.message}`);
}

/** El texto sale bien con Baileys; solo se agrega la espera de confirmación. */
export async function sendNewsletterText(sock, jid, text) {
  const id = newId(sock);
  return sendAndConfirm(sock, id, () => sock.sendMessage(jid, { text }, { messageId: id }));
}

export async function sendNewsletterImage(sock, jid, filePath, caption) {
  const buffer = await fs.readFile(filePath);
  const meta = await sharp(buffer).metadata();
  const mimetype = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[meta.format] || 'image/jpeg';
  const up = await uploadNewsletterImage(sock, buffer);
  const message = {
    imageMessage: {
      url: up.url,
      directPath: up.direct_path,
      mimetype,
      fileSha256: up.sha256,
      fileLength: buffer.length,
      width: meta.width,
      height: meta.height,
      ...(caption ? { caption } : {}),
    },
  };
  return sendStanza(sock, jid, message, { type: 'media', mediaType: 'image', mediaId: up.handle });
}

/** Encuesta común (`correctIndex` null) o cuestionario con respuesta correcta. */
export async function sendNewsletterPoll(sock, jid, { name, values, multi, correctIndex }) {
  const options = values.map((optionName) => ({ optionName }));
  const quiz = correctIndex !== null && correctIndex !== undefined;
  const poll = {
    name,
    options,
    selectableOptionsCount: quiz ? 1 : multi ? 0 : 1,
    ...(quiz ? { pollType: proto.Message.PollType.QUIZ, correctAnswer: options[correctIndex] } : {}),
  };
  const message = {
    messageContextInfo: { messageSecret: crypto.randomBytes(32) },
    ...(quiz ? { pollCreationMessageV5: poll } : poll.selectableOptionsCount === 1 ? { pollCreationMessageV3: poll } : { pollCreationMessage: poll }),
  };
  return sendStanza(sock, jid, message, {
    type: 'poll',
    extraNodes: [{ tag: 'meta', attrs: { polltype: 'creation' } }],
  });
}
