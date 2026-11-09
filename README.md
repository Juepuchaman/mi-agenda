# Mi Agenda

Es una app web personal para ver tus calendarios, tus tareas, tus ideas y tus notas de voz. Funciona en el celular y en el computador.

**La app no guarda datos propios.** Todo queda en tu cuenta de Google:

| Qué | Dónde queda |
|---|---|
| Eventos | Tus calendarios de Google Calendar (personal y de proyectos) |
| Tareas | Google Tasks, con una lista por tema |
| Ideas | Una lista de Google Tasks llamada «Ideas» |
| Notas de voz | La carpeta «Mi Agenda · Notas de voz» de tu Drive, enlazada desde la idea |

Por eso Ale (tu asistente de ChatGPT), la app de Google Calendar y las personas con quienes compartes un calendario ven y editan lo mismo.

## Qué hace

- **Agenda:** muestra la semana o el mes con todos tus calendarios juntos y las tareas que tienen fecha. Puedes crear, editar, mover y borrar eventos, e invitar gente.
- **Tareas:** organiza tus listas de Google Tasks. Puedes agregar tareas con fecha, marcarlas como hechas y crear listas nuevas.
- **Ideas:** guarda ideas escritas o grabadas. La grabación se transcribe en vivo cuando el navegador lo permite, y cada idea se puede convertir en tarea o en evento.
- **Ajustes:** eliges qué calendarios se muestran y en cuál van los eventos nuevos. También puedes crear un calendario por proyecto y **compartirlo** con alguien, con permiso para solo ver o para agregar y editar.

## Configuración (una sola vez)

### 1. Google Cloud: el permiso para entrar a tu cuenta

1. Entra a https://console.cloud.google.com y crea un proyecto llamado `Mi Agenda`.
2. Ve a **APIs y servicios → Biblioteca** y habilita estas tres:
   - Google Calendar API
   - Google Tasks API
   - Google Drive API
3. Ve a **Google Auth Platform** (o «Pantalla de consentimiento de OAuth»):
   - Tipo de usuario: **Externo**. Nombre de la app: `Mi Agenda`. Pon tu correo de contacto.
   - En **Público → Usuarios de prueba**, agrega tu correo de Gmail.
4. Ve a **Clientes → Crear cliente**, con el tipo **Aplicación web**:
   - En **Orígenes de JavaScript autorizados**, pon `https://TU_USUARIO.github.io` y `http://localhost:8765`.
   - En **URIs de redireccionamiento autorizados**, pon `https://TU_USUARIO.github.io/mi-agenda/` y `http://localhost:8765/`.
5. Copia el **ID de cliente** (termina en `.apps.googleusercontent.com`) y pégalo en `config.js`.

> Mientras la app esté en modo de prueba, Google muestra «Google no verificó esta app» al entrar. Como la app es tuya, toca **Continuar**.

### 2. GitHub Pages: la app en línea

1. En GitHub crea un repositorio llamado `mi-agenda`.
2. Sube estos archivos al repositorio.
3. Ve a **Settings → Pages → Branch: main / (root) → Save**.
4. Unos minutos después, la app queda en `https://TU_USUARIO.github.io/mi-agenda/`.

### 3. En el celular

- **iPhone:** abre la dirección en Safari → Compartir → **Agregar a inicio**.
- **Android:** abre la dirección en Chrome → menú ⋮ → **Instalar app**.

## Otras personas

No necesitan entrar a esta app. En **Ajustes → Compartir un calendario** les das acceso con su correo, y ellas agregan eventos desde su propio Google Calendar. Si alguien más quiere usar la app, hay que agregarlo como usuario de prueba en Google Cloud (paso 1.3).

## Notas técnicas

- Es un sitio estático: HTML, CSS y JavaScript, sin servidor ni base de datos.
- Usa OAuth de Google por redirección. El permiso dura una hora y se renueva solo.
- Tiene un service worker que guarda la app para que abra rápido. Los datos siempre se consultan en vivo a Google.
- Para probarla en el computador: `python3 -m http.server 8765` y luego abre http://localhost:8765.
