# WCM · Wpp Channel Manager

<img src="public/logo.svg" alt="" width="72">

Panel web para programar publicaciones en canales de WhatsApp. Se vinculan uno o más números escaneando un QR (como WhatsApp Web), se cargan publicaciones de texto, imagen o encuesta con día y hora, y el sistema las publica solo.

> **Importante:** WhatsApp no tiene una vía oficial para publicar en canales. Este sistema usa [Baileys](https://github.com/WhiskeySockets/Baileys), una librería no oficial que se conecta como un dispositivo vinculado. Va contra los términos de WhatsApp y un número puede ser bloqueado. Usá números dedicados, no personales, y publicá a un ritmo normal.

## Qué hace

- **Números:** vincular varios WhatsApp, cada uno con su QR. La sesión queda guardada y se reconecta sola al reiniciar.
- **Canales:** se agregan pegando el link del canal (`https://whatsapp.com/channel/…`). El número tiene que ser administrador.
- **Publicaciones:** texto (con formato de WhatsApp), imagen con texto al pie, o encuesta (2 a 12 opciones, una o varias respuestas). La encuesta puede llevar una imagen arriba (se publican seguidas) y puede ser un **cuestionario** con respuesta correcta (experimental). Vista previa mientras se escribe.
- **Programación:** a la hora elegida se publica sola. Botón "Publicar ahora" para probar.
- **Próximas, Historial y Biblioteca:** agenda por día, lo publicado o fallido con el motivo, y todo lo cargado con buscador. Cualquier publicación se puede duplicar para reusarla.
- **Usuarios:** rol *Contenidos* (carga y ve sus publicaciones) y rol *Administrador* (ve las de todos, maneja números, canales y usuarios).
- **Fallas:** si un número está desconectado a la hora de publicar, se reintenta durante 15 minutos y después queda como "Falló" con el motivo, para reprogramarla.

## Probarlo en una computadora

Necesita Node.js 22.13 o más nuevo.

```bash
npm install
npm start
```

Abrí http://localhost:3000, creá el usuario administrador y en **Números y canales** agregá un número de prueba y escaneá el QR desde el celular (WhatsApp → Dispositivos vinculados → Vincular un dispositivo).

## Instalarlo en un VPS

Con Docker (lo más simple):

```bash
git clone https://github.com/StriXShan/Wpp-Channel-Manager.git
cd Wpp-Channel-Manager
docker compose up -d --build
```

El panel queda en el puerto 3000. Los datos (base, sesiones de WhatsApp e imágenes) se guardan en la carpeta `data/`: **hacé copia de seguridad de esa carpeta**.

Para usarlo desde afuera conviene ponerle un dominio con HTTPS (por ejemplo con Caddy o Nginx delante) y configurar `SECURE_COOKIES=true`.

## Seguridad

La carpeta `data/whatsapp` contiene las sesiones de los números: quien la tenga puede publicar como ellos. Tratala como una contraseña.

Lo que ya trae el panel:

- Contraseñas cifradas (bcrypt) y cookies de sesión `HttpOnly`.
- **Verificación en dos pasos** opcional por usuario (en "Mi cuenta"), con cualquier app de códigos. Un administrador puede quitarla si alguien pierde el celular.
- Bloqueo de 15 minutos después de 5 intentos de login fallidos.
- Rechazo de formularios enviados desde otros sitios y encabezados de seguridad.
- **Fotos sin datos ocultos:** al subir una imagen se borran la ubicación GPS, el modelo del celular, la fecha y demás datos EXIF antes de guardarla. WhatsApp publica las imágenes de canales tal cual, así que sin esto esos datos llegarían a los seguidores.
- El panel pide a los buscadores que no lo indexen y no guarda registros de IP de quienes entran.

Lo que conviene hacer al instalarlo:

1. **Panel solo accesible por VPN privada (recomendado).** Instalá [Tailscale](https://tailscale.com) en el VPS y en las computadoras y celulares del equipo, y no abras el puerto 3000 a internet. En `docker-compose.yml` cambiá `"3000:3000"` por `"127.0.0.1:3000:3000"` y entrá con `tailscale serve 3000` o con la IP de Tailscale del VPS.
2. **Si el panel tiene que estar abierto a internet:** ponele un dominio con HTTPS (por ejemplo [Caddy](https://caddyserver.com): `reverse_proxy localhost:3000`), configurá `SECURE_COOKIES=true` y usá contraseñas largas.
3. **Firewall:** con `ufw`, dejá abierto solo SSH (y 443 si usás HTTPS público). Entrá por SSH con llave, no con contraseña.
4. **Copias de seguridad:** copia diaria y cifrada de la carpeta `data/` fuera del VPS.
5. **Actualizaciones:** mantené al día el sistema del VPS y, cada tanto, Baileys (`npm update baileys`), porque WhatsApp cambia seguido.

### Privacidad del equipo

Lo que ven los seguidores de un canal es el nombre, la foto y las publicaciones del canal. WhatsApp no les muestra los números de los administradores. Para reducir lo que se puede vincular con el equipo:

- **Números:** registrados a nombre de la empresa, con un nombre y una foto de perfil neutros, y en Privacidad: "Última vez", "Foto de perfil", "Info" y "Grupos" en *Nadie* o *Mis contactos*.
- **Contenido:** revisá que las imágenes no muestren datos en pantalla (capturas con nombres, notificaciones, direcciones). El panel borra los datos ocultos, pero no lo que se ve en la imagen.
- **Servidor:** cifrado de disco si el proveedor lo ofrece, y acceso solo por SSH con llave. Si usan dominio propio, activá la privacidad del WHOIS. Con Tailscale ni siquiera hace falta dominio.

Límites: WhatsApp sabe qué números administran cada canal y el proveedor del VPS sabe quién lo paga. Esto no se puede ocultar.

**IP frente a WhatsApp:** la conexión sale con la IP del VPS. Pasarla por un proxy residencial puede bajar algo las sospechas, pero no evita bloqueos: WhatsApp mira sobre todo el comportamiento. Por ahora no está incluido; se puede sumar como opción si algún número tiene problemas.

## Configuración

| Variable | Por defecto | Para qué |
| --- | --- | --- |
| `PORT` | `3000` | Puerto del panel |
| `DATA_DIR` | `./data` | Dónde se guardan base, sesiones e imágenes |
| `TZ` | `America/Argentina/Buenos_Aires` | Zona horaria de los horarios cargados |
| `MAX_DELAY_MINUTES` | `15` | Cuánto se reintenta una publicación si el número está desconectado |
| `SECURE_COOKIES` | `false` | `true` si el panel está detrás de HTTPS |

## Tests

```bash
npm test
```

## Pendiente

- Confirmar con un número real que imágenes y encuestas se publican bien en canales.
- Cuestionarios: se envían armando el mensaje a mano porque Baileys no tiene la opción. Hay que confirmar en la prueba que WhatsApp los acepta en canales.
- Preguntas de canal (respuestas abiertas de los seguidores): el formato del mensaje no es público todavía; queda como mejora a futuro.
- Funcionalidades aprobadas para la siguiente etapa: aprobación antes de publicar, plantillas, carga masiva, misma publicación en varios canales, resultados de encuestas, avisos por WhatsApp o mail y sugerencia de horarios.
