# Números y calentamiento en V7.4

Decisiones y estados: [ADR V7.4](adr-v7-4-numbers-warmup.md). Esta guía describe
lo que hace el operador. La biblioteca, los topes, la curva gradual, el horario
y la importación siguen como en [V7.2](warmup-v7-2.md).

## Dos recorridos al agregar un número

En **Números → Agregar número** eliges, antes del QR, una de dos opciones. La
elección se guarda con el número y se puede cambiar después («Cambiar» en su
tarjeta). Ninguna asigna variantes ni abre ventas por sí sola.

### 1. «Necesita calentamiento»

1. Registras el número (alias, país, teléfono opcional).
2. La plataforma prepara su conexión. Verás «Preparando…» (uno a cinco
   minutos), «tarda más de lo normal; seguimos intentándolo» o «no se pudo
   preparar» con **Reintentar la preparación**. Puedes cerrar la ventana: el
   número queda guardado.
3. Aparece el QR; lo escaneas desde WhatsApp → Dispositivos vinculados. Tras
   «Comprobando que sea tu número» queda **Conectado**. No hay que escanear dos
   veces.
4. La tarjeta dice **«Elige un grupo para empezar»**. No se envía nada todavía.
5. En **Calentamientos**: *Actualizar grupos* → eliges un grupo de WhatsApp en
   el que estén tus líneas → marcas cuáles enviarán (mínimo dos) → **Revisar**.
6. La revisión muestra quién envía, quién recibe, horario, volumen previsto y
   si hay participantes externos. Con externos, confirmas que aceptan esa
   actividad. **Guardar e iniciar**.
7. La tarjeta pasa a «Calentamiento activo · N de 14 días efectivos». Un día
   efectivo se acredita con mensajes enviados cuya entrega observó otra de tus
   líneas; el paso del calendario no cuenta.

### 2. «Ya está preparado; no iniciar calentamiento»

1. Registras y vinculas igual (pasos 1–3).
2. La tarjeta dice **«Ya preparado: sin calentamiento automático»** y el
   estado es «Listo para asignar». No se inscribe, no se programan ni envían
   mensajes de calentamiento y no hay mantenimiento, tampoco después de
   reconectar, reiniciar o actualizar la plataforma.
3. Para vender con él le asignas una variante, como siempre: esa asignación es
   la autorización humana. La preparación es una declaración tuya; no es una
   graduación observada.
4. Si está en un grupo de calentamiento de tus otras líneas, sólo recibe. Para
   que envíe, cambia su elección a «Necesita calentamiento»; entonces vuelve a
   «Elige un grupo» y nada arranca hasta que revises e inicies.

Cambiar un número que ya participaba a «ya preparado» conserva todo su
historial, cancela sólo sus envíos que aún no salían y deja ese calentamiento
en pausa hasta que lo revises.

## Grupos con participantes externos

- El grupo puede incluir personas o números sin cuenta en Commerce OS. No se
  les crea cuenta ni se les pide QR; no ocupan un número de tu plan; nunca
  envían desde aquí ni reciben mensajes privados.
- Sólo envían tus líneas elegidas, con su QR, identidad y salud vigentes.
- Si en el grupo «sólo escriben administradores», las líneas que envían deben
  ser administradoras.
- Si cambian los integrantes o los permisos, el calentamiento se pausa, se
  cancelan los envíos que no habían salido y debes revisar y confirmar otra vez.
- No hay evidencia de entrega para los externos: el avance se acredita con lo
  que observan tus propias líneas.

## Mensajes de «Actualizar grupos»

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| «…ya están conectadas y estamos terminando de comprobarlas» | La línea ya escaneó; falta una comprobación interna | Esperar un minuto. **No** escanear otra vez |
| «Ninguna de las líneas elegidas está conectada» | No hay sesión | Conectar desde Números |
| «No pudimos comunicarnos con el servicio de WhatsApp de la línea» | El gateway no respondió | Reintentar en unos minutos |
| «La sesión de la línea todavía se está iniciando» | Sesión arrancando | Reintentar en un minuto |
| «WhatsApp respondió con un formato que no reconocemos» | Incompatibilidad del proveedor | Avisar a soporte; tus líneas siguen conectadas |
| «…tus líneas no están en ningún grupo todavía» | Consulta correcta, sin grupos | Crear el grupo en WhatsApp con tus líneas |

Consultar grupos no envía ningún mensaje. Si recargas la página, la consulta
en curso se retoma.

## Eliminar un número que no se pudo cerrar desde aquí

Si la tarjeta de un número en eliminación pide **«Ya lo desvinculé en mi
teléfono»**: en el teléfono abre WhatsApp → Dispositivos vinculados, quita el
dispositivo de Commerce OS y confirma. Antes de terminar se comprueba que el
servidor de ese número ya no tenga ninguna sesión. El historial y los clientes
se conservan. Esta confirmación sólo la hace una persona en la aplicación.

## API y MCP (mismos servicios y errores que la web)

- `POST /v1/numbers/quick` acepta `warmup: "required" | "ready"`. Si se omite
  (clientes anteriores) se registra `required` con origen
  `compatibility_default`. MCP: `numbers_manage.crear` con
  `calentamiento: "necesita" | "listo"`.
- `POST /v1/numbers/{id}/warmup` `{mode, expected_version}` cambia la elección.
  MCP: `numbers_manage.cambiar_calentamiento`.
- `GET /v1/numbers/overview` y `GET /v1/numbers/{id}/link` devuelven
  `warmup` (modo, estado, días efectivos, programa), `preparation`, `detail` y,
  en una eliminación, `removal.phase`.
- `POST /v1/numbers/{id}/link` `{action:"retry_preparation"}`. MCP:
  `number_connection_manage.reintentar_preparacion`.
- `POST /v1/numbers/{id}/removal/unlink-confirmation`: sólo sesión humana
  (`HUMAN_CONFIRMATION_REQUIRED` con token). MCP: acción humana en la aplicación.
- `POST /v2/warmup/groups/refresh` responde `lines` (estado por línea) y
  `joined` cuando se une a una consulta en curso; `GET /v2/warmup` incluye
  `refresh` (última consulta, con resultado por línea).
- `GET /v2/warmup/groups`: `members[].kind` (`own` | `own_ready` | `external`)
  y `audience`. `POST /v2/warmup/preview`: `audience` con `consentRequired`.
- `POST /v2/warmup/programs/{id}/commands` `start`/`resume` con externos exige
  `audienceConfirmed: true`; sin él, `EXTERNAL_AUDIENCE_CONFIRMATION_REQUIRED`.
  Un agente sólo lo envía cuando la persona dueña confirmó ese consentimiento.
