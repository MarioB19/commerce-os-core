# Resiliencia, estado operativo y arquitectura de tarea

Fecha: 21-sep-2026.

Estado: aceptado para implementación. La publicación de software no autoriza conexión física, mensajería, campañas, gasto, calentamiento ni operación comercial REAL.

## Contexto

La interfaz podía mostrar simultáneamente una cuenta `WORKING`, una sesión detenida y una preparación incompleta. El laboratorio reutilizaba una ejecución anterior, representaba medios como marcadores y mezclaba mensajes persistidos con el mismo efecto del outbox. Capacidad contaba sólo slots materializados y podía mostrar cero sesiones frente a gateways existentes. Las siete rutas principales compartían identidad visual, pero no una jerarquía de tarea ni un contrato uniforme para dato vigente, parcial, ausente o histórico.

## Decisión

### 1. Estado derivado, no etiquetas independientes

Las lecturas operativas componen evidencia existente en vez de crear una segunda autoridad. Cada proyección expone:

- `state`: `READY`, `REQUIRES_ATTENTION`, `BLOCKED`, `IN_PROGRESS`, `UNKNOWN`, `UNAVAILABLE`, `NO_DATA`, `HISTORICAL`, `PARTIAL` o `STALE`;
- causa y siguiente acción;
- fuente, observación y vigencia;
- detalle técnico secundario.

Para números, la sesión observada y vigente prevalece sobre el estado descriptivo del catálogo. Asignación, salud, autorización, capacidad y simulación siguen siendo evidencias distintas: ninguna implica las demás. Los agregados son proyecciones de lectura; las mutaciones continúan en sus dominios actuales con permiso, idempotencia, versión, lock, auditoría y readback.

### 2. Laboratorio explícito y causal

Una prueba por número empieza vacía salvo selección explícita de un saludo de ejemplo. Crear o reiniciar prepara el snapshot, pero no representa una interacción del cliente. El transcript se construye desde mensajes materializados y utiliza `dispatch_sequence` como orden causal; el outbox queda sólo como evidencia técnica para efectos aún no materializados, evitando duplicados.

Los medios se proyectan mediante `asset_id`, MIME y nombre seguro. La UI usa el preview autenticado existente y nunca inserta bytes, secretos ni URL externas. Aceptación, comprobante, aprobación y reloj virtual son acciones contextuales dentro del chat. Toda la ejecución permanece en `SIMULATION`, `external_effects=false` y transporte aislado.

### 3. Preparación reanudable y recuperación conservadora

La ficha de un número compone ocho pasos: crear plaza, conectar, QR, identidad, salud, producto, simulación y autorización. El paso actual se deriva de datos persistidos, de modo que cerrar la vista o reiniciar un worker no pierde progreso.

Una operación remota `UNKNOWN` se concilia antes de habilitar otra. `FAILED` permite como máximo un restart autorizado dentro de la operación de recuperación; después se espera estado observable y sólo se solicita un QR fresco cuando el proveedor queda en `SCAN_QR_CODE`. Cambio de identidad congela ownership y envío. El QR sigue efímero, `no-store` y fuera de auditoría, notas y Git.

### 4. Capacidad como cinco cifras separadas

La lectura muestra por separado límite lógico, plazas provisionadas/verificadas, reservas, sesiones conectadas y capacidad física medida. Gateways legados se incluyen en la reconciliación sin mutar la base de datos. `available` no significa capacidad física; es headroom lógico explicable. La ausencia de medición se representa como `null`/`No medido`, nunca como cero.

Una ampliación REAL exige observación fresca de CPU, RAM y disco, ausencia de operación incierta y confirmación sobre un diff revisado. Este contrato no acredita el piloto físico 2→5→10→20.

### 5. Experiencia común para siete módulos

Se conserva la identidad azul y neutral existente. Cada ruta usa la misma secuencia visual: una ancla primaria, resumen compacto, tarea o cola central y evidencia histórica bajo demanda. Inicio tolera fuentes parciales; Campañas conserva el corte en URL; Resultados distingue cero de no verificable; Configuración separa estado vigente de historia; IDs y estados internos dejan de ser información primaria.

Los estados no dependen sólo de color. Controles interactivos conservan al menos 44 px, foco visible, HTML semántico y reducción de movimiento. Axe y capturas son evidencia parcial: teclado, zoom, lector de pantalla, jerarquía y copy se registran por separado.

### 6. Release y límites

El candidato se valida desde un checkout limpio. El mismo SHA debe ser probado, empaquetado `linux/amd64`, instalado por los scripts canónicos y releído por HTTPS. Como Actions está bloqueado por presupuesto, la validación local completa y el Deployment manual se registran separados del run fallido; no se afirma CI verde.

Antes y después se releen configuración, colas, comandos, sesiones, autorizaciones y outbox. El resultado esperado es cero efectos externos nuevos, REAL congelado y ninguna reactivación de autorizaciones. El instalador puede invalidar autorizaciones anteriores; no se restauran dentro de este alcance.

## Consecuencias

- Los endpoints agregados reducen cascadas, pero deben informar fallos por sección y no duplicar reglas de negocio.
- La migración sólo se añade si el progreso no puede derivarse de estado persistido existente; no se crea estado narrativo paralelo.
- F10 continúa separado: QR físico, identidad, recepción real, carga y observación de 21 días requieren nueva autorización y evidencia humana.
- Un rollback de aplicación no elimina migraciones ni sustituye una restauración B02; antes de reintentar se concilian unidad e informe remoto.

## Referencias

[Plan maestro](../00%20—%20Dirección/🧩%20Plan%20maestro%20—%20Resiliencia,%20UX%20y%20simulación%20—%20Commerce%20OS%20—%202026-09-21.md) · [Publicación](publishing-changes.md) · [CI/CD](ci-cd.md) · [Flujo de venta v2](adr-sales-flow-v2-2026-09-20.md)
