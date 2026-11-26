import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';

const ISSUER = 'Panel Canales';

const totpFor = (secret, label = 'usuario') =>
  new OTPAuth.TOTP({ issuer: ISSUER, label, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });

export function newSecret() {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

/** QR para escanear con Google Authenticator, Authy, 1Password, etc. */
export async function setupQr(secret, username) {
  return QRCode.toDataURL(totpFor(secret, username).toString(), { margin: 1, width: 220 });
}

export function verifyCode(secret, code, timestamp = Date.now()) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return false;
  return totpFor(secret).validate({ token: clean, timestamp, window: 1 }) !== null;
}
