import { config } from './config.js';
import { openDb } from './db.js';
import { WhatsAppManager } from './whatsapp.js';
import { Scheduler } from './scheduler.js';
import { createApp } from './app.js';

const db = openDb(config.dbPath);
const wa = new WhatsAppManager({
  sessionsDir: config.sessionsDir,
  onPhone: (id, phone) => db.prepare('UPDATE numbers SET phone = ? WHERE id = ?').run(phone, id),
});
const scheduler = new Scheduler({
  db,
  wa,
  uploadsDir: config.uploadsDir,
  maxDelayMinutes: config.maxDelayMinutes,
});

const app = createApp({ db, wa, config });
app.listen(config.port, () => {
  console.log(`Panel en http://localhost:${config.port} (zona horaria ${config.timezone})`);
});

await wa.restoreAll(db.prepare('SELECT id FROM numbers').all().map((n) => n.id));
scheduler.start(config.schedulerIntervalMs);
