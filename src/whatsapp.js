import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { Browsers, DisconnectReason, proto, useMultiFileAuthState } from 'baileys';

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });

// Mientras se espera el escaneo, WhatsApp renueva el QR varias veces.
// Pasado este tiempo sin escanear dejamos de pedir códigos nuevos.
const LINK_WINDOW_MS = 3 * 60 * 1000;

/**
 * Mantiene una conexión de WhatsApp (tipo WhatsApp Web) por cada número
 * vinculado. Cada número guarda su sesión en su propia carpeta, así que no hace
 * falta volver a escanear el QR después de reiniciar el servidor.
 */
export class WhatsAppManager {
  constructor({ sessionsDir, onPhone } = {}) {
    this.sessionsDir = sessionsDir;
    this.onPhone = onPhone || (() => {});
    this.entries = new Map();
  }

  dirFor(numberId) {
    return path.join(this.sessionsDir, String(numberId));
  }

  hasSession(numberId) {
    return fs.existsSync(path.join(this.dirFor(numberId), 'creds.json'));
  }

  /** Reconecta al arrancar todos los números que ya tienen una sesión guardada. */
  async restoreAll(numberIds) {
    for (const id of numberIds) {
      if (this.hasSession(id)) await this.connect(id).catch((err) => logger.error({ err, id }, 'restore failed'));
    }
  }

  status(numberId) {
    const e = this.entries.get(numberId);
    if (!e) return { state: this.hasSession(numberId) ? 'connecting' : 'unlinked' };
    return { state: e.state, qr: e.qr, error: e.error };
  }

  isConnected(numberId) {
    return this.entries.get(numberId)?.state === 'open';
  }

  /** Empieza a vincular: genera el QR para escanear desde el celular. */
  async startLink(numberId) {
    const e = this.entries.get(numberId);
    if (e && (e.state === 'open' || e.state === 'qr' || e.state === 'connecting')) return;
    await this.connect(numberId, { linking: true });
  }

  async connect(numberId, { linking = false } = {}) {
    const dir = this.dirFor(numberId);
    fs.mkdirSync(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);

    const entry = this.entries.get(numberId) || {};
    entry.state = 'connecting';
    entry.qr = null;
    entry.error = null;
    if (linking) {
      entry.linkUntil = Date.now() + LINK_WINDOW_MS;
      entry.gotQr = false;
    }
    this.entries.set(numberId, entry);

    const sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    entry.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (entry.sock !== sock) return; // conexión vieja ya reemplazada
      if (qr) {
        entry.gotQr = true;
        entry.state = 'qr';
        entry.qr = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
      }
      if (connection === 'open') {
        entry.state = 'open';
        entry.qr = null;
        entry.linkUntil = null;
        const phone = sock.user?.id?.split(':')[0]?.split('@')[0];
        if (phone) this.onPhone(numberId, phone);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        entry.sock = null;
        if (code === DisconnectReason.loggedOut) {
          entry.state = 'unlinked';
          entry.qr = null;
          entry.error = 'La sesión se cerró desde el celular. Hay que volver a escanear el QR.';
          fs.rmSync(dir, { recursive: true, force: true });
          return;
        }
        const linked = this.hasSession(numberId) && state.creds.registered;
        const stillLinking = entry.linkUntil && Date.now() < entry.linkUntil;
        if (linked || stillLinking || code === DisconnectReason.restartRequired) {
          entry.state = 'connecting';
          const delay = code === DisconnectReason.restartRequired ? 0 : 5000;
          setTimeout(() => this.connect(numberId).catch((err) => logger.error({ err }, 'reconnect failed')), delay);
        } else {
          entry.state = 'unlinked';
          entry.qr = null;
          entry.error = entry.gotQr
            ? 'No se escaneó el QR a tiempo. Probá de nuevo.'
            : 'No se pudo conectar con WhatsApp. Revisá que el servidor tenga internet.';
        }
      }
    });
  }

  /** Cierra la sesión en WhatsApp y borra los datos guardados de ese número. */
  async logout(numberId) {
    const e = this.entries.get(numberId);
    const sock = e?.sock;
    this.entries.delete(numberId);
    if (sock) {
      try {
        await sock.logout();
      } catch {
        sock.end(undefined);
      }
    }
    fs.rmSync(this.dirFor(numberId), { recursive: true, force: true });
  }

  socket(numberId) {
    const e = this.entries.get(numberId);
    if (!e || e.state !== 'open' || !e.sock) throw new Error('El número no está conectado.');
    return e.sock;
  }

  /**
   * Busca un canal por su link de invitación (https://whatsapp.com/channel/XXXX)
   * y devuelve su identificador interno y nombre.
   */
  async resolveChannel(numberId, link) {
    const code = parseChannelInvite(link);
    if (!code) throw new Error('El link no parece de un canal de WhatsApp.');
    const meta = await this.socket(numberId).newsletterMetadata('invite', code);
    if (!meta?.id) throw new Error('No se encontró el canal.');
    const role = String(meta.viewer_metadata?.role || '').toUpperCase();
    if (role && !['OWNER', 'ADMIN'].includes(role)) {
      throw new Error('Este número no es administrador del canal, así que no va a poder publicar.');
    }
    return {
      jid: meta.id,
      name: meta.thread_metadata?.name?.text || meta.thread_metadata?.name || meta.name || 'Canal sin nombre',
      invite: code,
    };
  }

  async send(numberId, jid, content) {
    return this.socket(numberId).sendMessage(jid, content);
  }

  /** Envía un mensaje armado a mano (por ejemplo, un cuestionario). */
  async sendRaw(numberId, jid, message) {
    return this.socket(numberId).relayMessage(jid, proto.Message.fromObject(message), {});
  }
}

export function parseChannelInvite(link) {
  const s = String(link || '').trim();
  const m = s.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{10,}$/.test(s) ? s : null;
}
