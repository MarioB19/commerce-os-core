# ADR · Continuidad de REAL y relevo del canal (2026-09-23)

## Decisión

La revisión de `operational_settings` representa configuración comercial y sólo cambia por mutaciones comerciales. Una publicación compatible instala un **release hold** transitorio en la base, sin incrementar esa revisión ni renovar autorizaciones. Todas las lecturas de política usadas por API y workers tratan el hold como `dispatch_frozen=true`. El instalador congela la propiedad del worker anterior antes de detenerlo, verifica su aislamiento y conserva un recibo de transferencia. El nuevo worker sólo libera una cuenta que estaba operando antes del corte después de adquirir la nueva generación, releer salud e identidad y descartar controles humanos, incidentes ajenos y efectos inciertos. La comprobación se ejecuta por cuenta; el fallo de una no detiene las demás.

La primera publicación que introduce este contrato sigue el congelamiento anterior porque el binario instalado aún no conoce el hold. Rollback a un binario sin soporte también usa el congelamiento anterior. Un fallo de instalación deja el hold activo y se informa como incidente; nunca se reabre por el mero éxito de `docker compose`.

`Abrir ventas` será una orden humana con alcance explícito y lectura posterior por número. Una autorización vencida, revocada o con identidad/catálogo diferente exige una nueva decisión humana; el instalador no la extiende. `Pausar ventas` conserva el corte inmediato. Los comandos y salidas inciertas jamás se reintentan al reabrir.

## Razón

El instalador actual cambia la política REAL tres veces y deja toda propiedad congelada. Cada incremento de versión invalida todas las autorizaciones por el guard del dispatcher, aunque sólo se haya publicado software. La separación mantiene la restricción temporal de seguridad sin transformar la publicación en una modificación comercial.

## Límites

Un único VPS y WAHA/QR siguen siendo puntos de interrupción. No se promete disponibilidad continua ni se sustituye la validación física. Las actualizaciones que alteren los contratos de dispatch, identidad o autorización requieren un relevo explícito o congelamiento antiguo hasta demostrar compatibilidad. El resultado verificable es política, propiedad, salud, autorización y efectos por cuenta, más la lectura HTTPS del SHA instalado.
