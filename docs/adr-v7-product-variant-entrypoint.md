# V7 — Producto y variante con opciones nativas

## Decisión previa

La pantalla de variantes no puede fabricar hashes, versiones ni vínculos desde
metadatos del navegador. Un GET cerrado bajo `variants:read` recibe únicamente el
ID del producto y entorno y proyecta sus ofertas publicadas y sus referencias
nativas actuales de flujo, vendedor, cobro y materiales. Cada referencia usa el
mismo hash de `record_versions` que la publicación008 vuelve a comprobar. Sólo
salen identidad, etiqueta y hash; ningún cuerpo bancario, secreto o instrucción.
El producto debe pertenecer al mismo perfil/entorno. Adoptar familia continúa
siendo una acción explícita con CAS; la lectura no crea ni elige variantes.

La proyección tiene cota total explícita y rechaza exceso, sin afirmar que una
lista truncada está completa. La publicación conserva todas las comprobaciones
de moneda, importe, enlaces, materiales y revisión. El formulario conserva su
semántica; no se crea autorización de envío ni una asignación.

La entrada de Productos enlaza a una ruta de variantes con ID validado. Recarga
los datos bajo la selección nativa y desmonta todo al cambiar el perfil. Antes de
montar escrituras, la operación incierta se guarda en sessionStorage por usuario,
perfil, entorno y producto antes del POST. Al volver sólo permite consultar ese
UUID; sólo un 404 cuyo cuerpo cerrado confirma `MARKET_NOT_FOUND` en el
endpoint de operación permite reenvío humano del mismo contenido. HTML, errores
de proxy, cuerpos extra o un404 de otro endpoint conservan incertidumbre. Un
fallo o contenido inválido de almacenamiento bloquea escrituras, nunca autoriza
un UUID nuevo que pueda duplicar la operación anterior.

## Verificación

Contratos/HTTP: scope fijo, no identidad desde body, referencias correctas y sin
secretos. PostgreSQL con rol API restringido y catálogo compuesto: producto y
referencias ajenos o de otro entorno inaccesibles, SHA igual al validador nativo,
lectura sin adopción, publicación válida desde opciones y guards sin cambios.
Chromium: recorrido desde producto, borrador/adopción explícitos, refresco y
reconciliación de respuesta perdida, cambio de perfil sin fuga y modo no visible.
No proveedor, asignación, Cloud Build ni efecto externo.

Comprobado localmente:74 host,24 PostgreSQL sobre43 componentes + RLS y login
restringido,9 Chromium de la entrada real con API sintética,9 Chromium previos de
variantes,5 Node del catálogo browser16,tipos raíz/web y lint. El PG conserva el
adaptador sintético de cookie; selección, membresías, PAT, datos, hashes y
publicación son nativos. Los dos fallos iniciales de Chromium se debieron a
selectores del fixture (texto de enlace y nombre accesible de select), corregidos
sin cambiar assertions ni producto.

El peer detectó que el cliente anterior habilitaba reenvío por status404 sin
validar el cuerpo. El cierre añade un resultado finito exclusivo de la consulta
de operación, con pruebas de HTML/proxy/shape ajeno y regresión de recarga.
Sin repetición de PG porque este delta final sólo afecta cliente/estado de UI;
las fuentes SQL/API medidas por el ensayo24 permanecen idénticas.

El montaje no adopta asignaciones ni autoridad comercial. Quedan fuera la
navegación V7 completa, autores de oferta/material, consumidores worker, cierre
F8, backup/restore actualizado y FULL/publicación nativos.
