import crypto from 'node:crypto';
import path from 'node:path';

// La zona horaria se fija antes de cualquier uso de Date para que los horarios
// cargados en el panel se interpreten como hora local del equipo.
process.env.TZ = process.env.TZ || 'America/Argentina/Buenos_Aires';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');

export const config = {
  port: Number(process.env.PORT || 3000),
  timezone: process.env.TZ,
  dataDir,
  dbPath: path.join(dataDir, 'app.db'),
  sessionsDir: path.join(dataDir, 'whatsapp'),
  uploadsDir: path.join(dataDir, 'uploads'),
  // Si una publicación no puede salir (número desconectado), se reintenta
  // hasta este margen y después se marca como fallida.
  maxDelayMinutes: Number(process.env.MAX_DELAY_MINUTES || 15),
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 20000),
  secureCookies: process.env.SECURE_COOKIES === 'true',
  // Código para crear el primer administrador. Si no se define, se genera uno
  // al arrancar y se muestra en los registros del servidor.
  setupToken: process.env.SETUP_TOKEN || crypto.randomBytes(9).toString('base64url'),
};
