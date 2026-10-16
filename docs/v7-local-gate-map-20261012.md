# Mapa de trabajo local F0–F9

Corte documental y de código del 12-oct-2026. Fuentes: matriz RF/RNF y fases V7
del vault, arquitectura de aplicación y requisitos RF-05/06/14/19; código
80a6 + incremento RF14 f80fa25 y evidencia local independiente. La matriz del
vault conserva muchos «Pendiente» generales: los paquetes locales no cierran
por sí solos sus filas ni sustituyen instalación/operación. Root mantiene los
recibos cambiantes de FULL y efectos nativos; este mapa no los sobrescribe.

| Fase | Base comprobable | Trabajo local pendiente de valor | Gate que permanece abierto |
|---|---|---|---|
| F0 | Tooling y operadores revisados; candidato público 51f72 separado | Diagnóstico Create/UUID binding y contratos nativos | FULL/atestación/main/package/install/readback propios; no heredar PASS |
| F1 | PR52: cuota17/37 histórica, restore16 originales compatible68+8, PITR local, preparador observe/seal | Ensamblado canónico MAIN y validación de backup nuevo | Backup nuevo/custodia bajo instalación, WAL/PITR productivo, cuotas futuras y SLO; sólo Root muta |
| F2 | Rama de mantenimiento: perfiles/sesiones/PAT/invitaciones/catálogo y pruebas HTTP/PG restringidas | Contexto real de todos los consumidores, outbox/autoridad y montaje | Migración RLS/IDs/historia, API/MCP/UI y aislamiento integral; ownership mantenimiento |
| F3 | V5 `commercial-assignments`, timers y workers; guards por cuenta | Bindings permanentes, estados de protección y reconciliación/hot add con puertos falsos | LIFE50/CONT3/CHAOS único emisor, contratos F2, capacidad20; QR físico separado |
| F4 | RF14 f80fa25 y motor de variantes; persistencia 008 con FORCE RLS, API bajo autoridad F2 y cliente común preparados en rama privada | Montaje comercial de interfaz/MCP preparados y proyección autorizada de asignaciones F3 hacia el resolver compartido | Migración producto→México y materiales; RLS integral, paridad API/MCP/Web y worker/laboratorio; FULL/install/readback propios |
| F5 | Pagos, receipt-sales y commercial-remarketing existentes | Reglas heredadas por variante; monto/moneda/fecha/duplicado; ledger/export y calendario DST | RLS y carreras DB; igualdad pagos/resultados/campañas por moneda; entrega real distinta de fixture |
| F6 | Simulaciones y motor de flujo existentes | Laboratorio por número con mismo resolver, snapshot y puertos de efectos; golden3variantes/2mercados | Rol/egress/colas técnicamente aislados;0delta real antes/después;UI/API/MCP e historial/costo |
| F7 | Reportes y documentación existentes | Proyecciones por variante/padre/moneda, costos desconocidos, ayuda y registry común | Consultas reales aisladas, paridad cliente MCP real y autoservicio humano cronometrado |
| F8 | Inventario de retiro previsto; legado aún presente | Clasificador de dependencias y plan/export/restore de retiro verificable |7d de lectura/entrega sana, export íntegro y autorización de borrado; no borrar para probar |
| F9 | Suites locales parciales y evidencia histórica | Oráculos de carga/caos, regresiones continuidad/aislamiento y calendario de observación | Escala20, sesiones físicas, DR real y observación7/30d; ninguna se simula como cumplida |

Se elige F4 porque habilita F5/F6/F7 sin depender de nube ni claves. El primer
contrato no mueve productos actuales ni permite escoger otro perfil desde una
petición. Se trabaja en `codex/v7-f4-market-variants`, separado de la rama F2 y
del candidato F0. Mantenimiento conserva perfiles, credenciales, outbox y todos
sus consumidores. La decisión está en `adr-v7-market-variant-routing.md`.

Validación prevista: contratos cerrados/identidades y límites; copia independiente
sin asignaciones o secretos; conflictos/staleness/pausa; snapshot histórico;
paridad de decisión REAL/SIMULATION sin red. Validación ejecutada se registrará
aparte con hashes; esta lista no es un recibo PASS.

Ampliación privada de F4: `codex/v7-f4-variant-persistence` integra el puerto F2
de `d75310e` y el núcleo F4 revisado. La transición008 sigue fuera de las68
migraciones aplicadas. Publicación/copia/CAS/snapshot, retención de material
publicado y recibos de operación se prueban con PostgreSQL17.11 y rol restringido;
el cliente compartido usa exactamente la API preparada, sin identidad global
ni repetición automática. El recorrido TCP del consumidor se verifica por
separado antes de cerrar ese alcance. La revisión de persistencia no acredita
montaje en createApp/MCP comercial ni captura de journeys desde un worker real.
El incremento ya cuenta con cliente/MCP y vista preparada revisados:120 pruebas
focales y9 Chromium sintéticos. El ensayo posterior pasó15 casos reales
TCP/PostgreSQL, incluido cliente/MCP, separado del navegador sintético. Las fixtures de transiciones deben aislarse también en FULL.
Los resultados y sus límites permanecen en la evidencia del incremento.
