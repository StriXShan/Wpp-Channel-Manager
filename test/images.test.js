import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { stripImageMetadata } from '../src/images.js';

test('borra la ubicación y demás datos EXIF de las fotos', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'img-')), 'foto.jpg');
  await sharp({ create: { width: 40, height: 20, channels: 3, background: '#3a7' } })
    .jpeg()
    .withExif({ IFD0: { Make: 'Telefono', Model: 'Modelo X' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '34/1 36/1 0/1' } })
    .withMetadata({ orientation: 6 })
    .toFile(file);
  const before = await sharp(file).metadata();
  assert.ok(before.exif, 'la foto de prueba tiene EXIF');

  await stripImageMetadata(file, 'image/jpeg');
  const after = await sharp(file).metadata();
  assert.equal(after.exif, undefined);
  assert.equal(after.orientation, undefined);
  assert.deepEqual([after.width, after.height], [20, 40], 'aplica la rotación antes de borrar');
});
