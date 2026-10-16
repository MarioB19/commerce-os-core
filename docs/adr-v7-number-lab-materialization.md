# ADR V7 — Materialización del motor de laboratorio

Decisión previa, 12-oct-2026. El servidor, no el cliente HTTP, es dueño de los
pools separados de control, siembra y ejecución. El materializador obtiene el
claim desde `NumberLabWorkerStore` y espera su COMMIT antes de usar captura o
acción. No admite un plan, resultado de claim, entorno o ejecutor fabricado por
el caller. Compila otra vez el sobre autenticado y exige la identidad instalada
exacta del motor.

La base aislada registra una materialización por run y una ejecución por
operación. El primer seed, sus versiones y el recibo READY se confirman juntos;
una falla revierte todos esos cambios. La pérdida de ACK del COMMIT deja el
control INTENT: sólo se permite consultar el recibo, nunca volver a reclamar o
resembrar por ausencia de respuesta. Un siguiente comando legítimo reutiliza
únicamente la misma configuración READY y abre una ejecución distinta.

El permiso seed se restringe a la ventana SEEDING. Los esqueletos mutables
(category/product/workflow) se finalizan una vez dentro de esa misma transacción;
los registros inmutables se insertan en orden de dependencias. READY impide
volver a editar configuración. Se conservan las guardas históricas, el entorno
SIMULATION, IDs propios, origen por variante y clasificación TEST. No se crean
sesiones, credenciales, grants de operación ni transporte REAL.

Los materiales son un puerto privado aparte: debe entregar copias verificadas
contra cada referencia/hash/tamaño y un recibo ligado a run/snapshot. El motor
no recibe el directorio, clave o storage_key REAL. Ninguna URL, código de acceso
o archivo faltante se reemplaza por contenido sintético. Este incremento
acepta descriptores del broker autenticado; su implementación de custodia y el
montaje completo siguen siendo prerrequisitos explícitos. Este puerto sólo admite
materiales file; link/access quedan cerrados hasta sus adaptadores propios.

La creación del simulation y evento causal corresponde al driver canónico
posterior, que opera con el lease nativo. Materializar configuración por sí solo
no acredita una conversación, una prueba de IA ni el recorrido funcional RF19.
