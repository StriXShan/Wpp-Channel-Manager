import fs from 'node:fs/promises';
import sharp from 'sharp';

/**
 * Las fotos de celular traen datos ocultos (EXIF): ubicación GPS, modelo del
 * teléfono, fecha y hora. WhatsApp publica las imágenes de canales tal cual se
 * suben, así que esos datos llegarían a los seguidores. Acá se reescribe la
 * imagen sin metadatos, aplicando antes la rotación para que no quede de costado.
 */
export async function stripImageMetadata(filePath, mimetype) {
  const input = await fs.readFile(filePath);
  let img = sharp(input).rotate();
  if (mimetype === 'image/png') img = img.png();
  else if (mimetype === 'image/webp') img = img.webp({ quality: 90 });
  else img = img.jpeg({ quality: 90, mozjpeg: true });
  const output = await img.toBuffer();
  await fs.writeFile(filePath, output);
}
