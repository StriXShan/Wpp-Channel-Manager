import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginLimiter, sameOrigin } from '../src/security.js';

test('bloquea después de 5 intentos fallidos y se libera con el tiempo', () => {
  let now = 0;
  const l = new LoginLimiter({ now: () => now });
  for (let i = 0; i < 5; i++) l.fail('1.1.1.1', 'ana');
  assert.equal(l.isBlocked('1.1.1.1', 'ana'), true);
  assert.equal(l.isBlocked('2.2.2.2', 'ana'), false);
  now = 16 * 60 * 1000;
  assert.equal(l.isBlocked('1.1.1.1', 'ana'), false);
});

test('rechaza formularios que vienen de otro sitio', () => {
  const run = (headers) => {
    let status = 200;
    const req = { method: 'POST', get: (h) => ({ host: 'panel.com', ...headers })[h] };
    const res = { status: (s) => ((status = s), res), send: () => {} };
    sameOrigin(req, res, () => {});
    return status;
  };
  assert.equal(run({ origin: 'https://panel.com' }), 200);
  assert.equal(run({ origin: 'https://malo.com' }), 403);
  assert.equal(run({ referer: 'https://malo.com/x' }), 403);
});
