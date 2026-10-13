# Cómo contribuir a Klip

¡Gracias por querer mejorar Klip! Es un proyecto libre (licencia MIT) y cualquier ayuda cuenta:
reportar un error, proponer una idea, mejorar la documentación o enviar código.

## Reportar errores y proponer ideas

Usa las plantillas de [Issues](https://github.com/LudwigAngel/klip/issues/new/choose).
Para errores, incluye la versión de Klip, la de Windows, tu configuración de monitores y, si puedes,
una captura o GIF. Revisa que no aparezcan datos privados.

## Preparar el entorno

Necesitas Windows 10/11 de 64 bits, [Node.js](https://nodejs.org) 22 o superior y Git.

```bash
git clone https://github.com/LudwigAngel/klip.git
cd klip
npm install
npm start
```

Si `npm install` avisa de que bloqueó el script de Electron (npm 11 o superior), apruébalo:

```bash
npm approve-scripts electron
npm rebuild electron
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm start` | Arranca Klip en modo desarrollo (icono en la bandeja). |
| `npm run check` | Revisa la sintaxis de todos los archivos JavaScript. |
| `npm run smoke` | Prueba automática: captura, OCR, ventanas, grabación MP4/GIF, todas las páginas y el editor. |
| `npm run dist:dir` | Empaqueta la app en `dist/win-unpacked` sin crear instalador. |
| `npm run dist` | Genera el instalador `dist/Klip-Setup-x.y.z.exe`. |

Para regenerar las capturas del README (usan datos de ejemplo, no tu escritorio):

```bash
set KLIP_SCREENSHOTS=docs\screenshots&& npx electron .
```

## Cómo está organizado

- `src/main.js` — proceso principal: bandeja, atajos, capturas, grabación, ventanas e IPC.
- `src/preload.js` — el único puente entre las páginas y el proceso principal. Las páginas corren
  con `contextIsolation` y `sandbox`; cualquier canal nuevo debe declararse aquí.
- `src/settings.js` — valores por defecto y guardado de la configuración. Un ajuste nuevo se añade en
  `defaults()` y en `src/renderer/settings.html`.
- `src/ocr.ps1`, `src/windows.ps1` — ayudantes de PowerShell (OCR de Windows y posición de ventanas).
- `src/logo-raster.js` — dibuja el logo para la bandeja y el `.ico`. El original vectorial está en `docs/logo.svg`.
- `src/renderer/` — una página por ventana: `overlay` (selección), `editor`, `quick` (miniatura),
  `pin`, `recorder` (oculta, graba), `bar`, `frame`, `webcam`, `ocr`, `settings`.

## Enviar un pull request

1. Haz *fork* y crea una rama desde `main`: `git checkout -b mejora/clics-en-grabacion`.
2. Haz cambios pequeños y enfocados; un tema por pull request.
3. Antes de enviarlo ejecuta `npm run check` y `npm run smoke`.
4. Si cambias algo visual, añade capturas de antes y después.
5. Abre el pull request contra `main` y rellena la plantilla. La integración continua (GitHub Actions)
   repetirá las pruebas en Windows.

### Estilo

- JavaScript moderno sin frameworks ni compiladores; sigue el estilo del archivo que tocas.
- Los textos de la interfaz van en español.
- Usa los colores y componentes que ya existen en cada página.
- Evita dependencias nuevas; si hacen falta, fija la versión exacta y explica por qué.
- Klip es un proyecto independiente: no copies código, iconos ni diseños de CleanShot X ni de otras
  apps de pago. Inspirarse en una función está bien; copiarla tal cual, no.

## Publicar una versión (mantenedores)

1. Sube `version` en `package.json` (por ejemplo `0.3.2`) y fusiónalo en `main`.
2. Crea la etiqueta y súbela: `git tag v0.3.2` y `git push origin v0.3.2`.
3. GitHub Actions compila el instalador y lo adjunta al Release `v0.3.2` junto con su suma SHA-256.

## Código de conducta

Trata a todos con respeto. Críticas al código, nunca a las personas.
