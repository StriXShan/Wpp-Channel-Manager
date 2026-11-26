# Wpp Channel Manager

Panel web para programar publicaciones en canales de WhatsApp. Se vinculan uno o más números escaneando un QR (como WhatsApp Web), se cargan publicaciones de texto, imagen o encuesta con día y hora, y el sistema las publica solo.

> **Importante:** WhatsApp no tiene una vía oficial para publicar en canales. Este sistema usa [Baileys](https://github.com/WhiskeySockets/Baileys), una librería no oficial que se conecta como un dispositivo vinculado. Va contra los términos de WhatsApp y un número puede ser bloqueado. Usá números dedicados, no personales, y publicá a un ritmo normal.

## Qué hace

- **Números:** vincular varios WhatsApp, cada uno con su QR. La sesión queda guardada y se reconecta sola al reiniciar.
- **Canales:** se agregan pegando el link del canal (`https://whatsapp.com/channel/…`). El número tiene que ser administrador.
- **Publicaciones:** texto (con formato de WhatsApp), imagen con texto al pie, o encuesta (2 a 12 opciones, una o varias respuestas). Vista previa mientras se escribe.
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
- Cuestionarios y preguntas: Baileys no los soporta todavía; quedan como mejora a futuro.
- Funcionalidades aprobadas para la siguiente etapa: aprobación antes de publicar, plantillas, carga masiva, misma publicación en varios canales, resultados de encuestas, avisos por WhatsApp o mail y sugerencia de horarios.
