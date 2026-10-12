# ADR V7 — Cierre de referencias del laboratorio

Decisión previa, 2026-10-12. Antes de materializar el motor aislado, la captura
nativa debe incluir las referencias comerciales anidadas de cada configuración:
subflujos, categorías, materiales, políticas, banco, vendedor y procedencia de
campaña. El catálogo de claves es explícito y compartido con el compilador puro;
no se interpretan UUID arbitrarios del texto como referencias.

Primero se fijan todas las raíces versionadas de F4 y los bindings auténticos.
Después se recorre su cierre. Una referencia que ya tiene una única revisión
fijada conserva esa revisión; una dependencia sin pin se lee del registro actual
bajo lock de su padre y se verifica contra record_versions. No se elige una
revisión por orden de lectura. Si un mismo ID tiene revisiones incompatibles,
esta captura se rechaza con diagnóstico de ambigüedad; un futuro grafo con aristas
por variante será necesario para representar ese caso sin cambiar su significado.

El cierre tiene máximo 300 registros y cada cuerpo recorrido límites de
profundidad y elementos. No se omiten dependencias por llegar al límite. Se
conservan hashes originales de versión y el hash de toda la proyección cerrada.
Assets deben seguir READY; ofertas y workflows deben estar publicados. Sólo la
proyección de campos comerciales cruza la frontera; credenciales, almacenamiento,
autorizaciones y datos bancarios sensibles permanecen en custodia REAL.

El compilador posterior debe validar nuevamente hash/cierre, asignar IDs propios
por run/variante, conservar los originales como procedencia y remapear toda clave
reconocida. Nunca sustituirá una referencia ausente por undefined, una clave por
un mock ni un archivo por contenido inventado. Captura y compilación no conceden
permisos SQL, de proveedor o de envío; el lease y los brokers siguen separados.

## Compilador puro

El plan local deriva IDs estables con dominio propio a partir del run y variante,
y copia cada grafo alcanzable por separado. Así dos variantes del mismo producto
no comparten registros mutables ni asignaciones del motor. Los UUID derivados son
IDs propuestos para la base aislada, nunca identificadores nativos fingidos.

Las referencias se reescriben con un mapa total. Se conserva la identidad del
vendedor y la configuración publicada, sin cambiar su proveedor a deterministic.
Archivos/accesos y secretos bancarios permanecen pendientes de brokers explícitos;
el plan sólo lleva descriptores de material y jamás escribe almacenamiento,
credenciales o SQL. La tabla de orden propone esqueletos de entidades mutables,
entidades inmutables en orden de dependencias y cierre de esqueletos. Un ciclo
entre entidades inmutables bloquea antes de crear nada. No se ejecutan handlers,
funciones de negocio, scripts ni contenido del catálogo durante la compilación.

## Verificación local

31 pruebas unitarias, 14 PostgreSQL nativas y revisión independiente de captura
(17) y compilador (14) aprobadas. El primer ensayo nativo conservado intentó
guardar una referencia inexistente y la integridad SQL lo rechazó antes de
capturar; el caso final comprueba ese rechazo y la captura válida sin cambios.
No se deshabilitaron triggers, asserts ni permisos. Tipos y lint aprobados.
La compilación no acredita materialización, archivos, ejecución de IA ni montaje.
