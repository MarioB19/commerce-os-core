# Lector FULL: continuación acotada de una misma búsqueda

Decisión local, 2026-10-11. Estado: revisión independiente aprobada; no instalado.

Cloud Logging puede devolver una página vacía y `nextPageToken` cuando no ha
terminado de buscar. El lector canónico actual rechaza esa respuesta de forma
segura, pero impide completar ATTEST y las verificaciones FULL de PACKAGE y
PUBLISH. El lector administrativo ya pudo observar el mismo caso. No se cambia
el candidato b170 ni se reinterpretan recibos parciales como FULL aprobado.

Se prepara un parche separado de `GoogleFullReader.logs`: hasta ocho páginas,
menos de cien entradas acumuladas y cuatro MiB de respuestas raw acumuladas.
Cada continuación conserva recurso, filtro, orden y tamaño de página; solamente
agrega el token real anterior. Un token repetido, demasiado largo, una octava
página con continuación, un error o el vencimiento del presupuesto local impiden
devolver evidencias. No hay reintentos de la misma página ni deduplicación que
pudiera ocultar dos recibos. Los validadores de identidad y exactamente un recibo
FULL con sus 21 etapas siguen siendo los originales.

Se conserva el filtro canónico exacto. No se agrega `createTime` como límite de
timestamp en este incremento: la captura de boot y su lector Root autentican
exactamente ese filtro y las páginas raw. Alterarlo sólo en el adaptador rompería
la custodia de PUBLISH; además el contrato actual no acredita una relación entre
el reloj de cada LogEntry y la creación del Build. Una optimización temporal
necesitaría una decisión y actualización conjunta de esos contratos. La
paginación por sí sola es compatible con ambos consumidores existentes.

El presupuesto local de logs es 90 segundos, comprobado antes y después de cada
I/O, con timeout de socket de como máximo veinte segundos y sin nueva petición
después del vencimiento. No se presenta como límite absoluto contra un stream
que gotea: se conserva el fusible absoluto del worker/attestor. Hasta siete
peticiones Logging adicionales por evaluación deben incorporarse a la admisión
de una imagen futura. El camino actual adquiere ADC mediante dos peticiones por
lectura: la cota estática aumenta en 21 HTTP, de 123 a 144 para PR y de 121 a 142
para MAIN. Se conserva el fusible exterior de 120 segundos; esa cota de peticiones
no garantiza terminar dentro del plazo. No se instala el parche sobre una imagen
inmutable ni se presenta una prueba local como FULL del candidato.

Pruebas locales: páginas vacías y parciales, tokens/bounds, errores sin replay,
recibos duplicados y compatibilidad con la captura real de boot/package. Los
datos son sintéticos y no hay Google API, claves ni cambios de estado.

Fuentes oficiales consultadas: [entries.list](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list)
y [Build](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.builds).
