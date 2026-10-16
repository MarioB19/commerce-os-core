# ADR V7 — Workflow canónico mediante el puerto del laboratorio

Decisión previa, 2026-10-12. RF19 conserva los tres runners comerciales y sus
exportaciones actuales. Se extrae únicamente su dependencia de query y transacción
a un objeto privado; las implementaciones y consultas siguen siendo las mismas.
El punto de entrada del laboratorio acepta un lease opaco autenticado y un límite
entero acotado. No recibe pool, entorno, SQL, callback ni autoridad del cliente.

Cada escaneo y transición usa una fase corta del motor aislado y su RLS del run.
Los timers conservan su reloj virtual canónico, sus causas, cuotas, controles y
cursor de workflow. El proponente crea sólo outbox SIMULATION; este adaptador no
consume ni envía ese outbox. El permiso del lease vuelve a comprobarse después de
cada fase y antes de exponer su resultado.

La verificación nativa usará registros sintéticos con el contrato persistido
NUMBER_FLOW_TEST_V1 y workflow publicado. Debe demostrar pedido TEST, efecto único,
timer causal, pausa propia y separación entre runs. No equivale a captura/materialización
F4 completa, IA real, comprobantes, transporte ni montaje de API/MCP/UI; esos
componentes se integran por puertos independientes y con sus pruebas.

El primer PG de workflows encontró un permiso faltante del trigger de versiones:
`retention_context_valid()` requiere EXECUTE explícito incluso cuando el registro
no es un asset. Se concede sólo esa comprobación booleana al rol de ejecución.
El login del ensayo no es superusuario ni maintenance; la función conserva sus
condiciones originales y devuelve false. No se conceden tablas de retención,
ningún apply_retention_plan ni permisos para alterar versiones históricas.

Verificación local final: 41 unitarias (27 frontera, 10 adaptador y 4 flujos
existentes), 18 PostgreSQL reales, TypeScript y ESLint PASS. Peer independiente
leyó las fuentes completas y ejecutó 37 (frontera + adaptador); no se suma ese
reensayo al total. Los dos intentos fallidos previos quedan preservados: el
permiso booleano descrito y un control sintético incompleto. El ensayo final
conservó exactamente 5 contenedores y 65 volúmenes ajenos, y retiró sólo la base,
roles y contenedor propios después del PASS. [Evidencia segura](evidence/v7-number-lab-canonical-workflows-local.json).
