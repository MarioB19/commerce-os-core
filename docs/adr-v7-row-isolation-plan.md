# V7 — Propuesta explícita del corte de filas

Fecha: 2026-10-12. Estado: implementación local; no adopción ni montaje.

El planificador recibe el catálogo completo de tablas públicas y privadas y una
clasificación explícita de cada `schema.table`. Una tabla puede conservar una
frontera revisada o recibir un scope de perfil y, cuando corresponda, entorno.
La ausencia de columnas nunca significa que sea global. Cada rol destinatario
debe existir en el inventario sin superusuario, BYPASSRLS ni creación de roles.

La propuesta no concede SQL, membresías, propiedad ni ejecución de funciones.
Habilita y fuerza RLS únicamente en tablas clasificadas para el corte y añade
una política restrictiva por los roles exactos declarados. Las políticas activas
anteriores se conservan. Sólo una tabla que todavía no tenía RLS habilitada puede
recibir, mediante decisión explícita, una política permisiva del mismo scope:
no se puede ampliar el acceso de una tabla que ya dependía de una política de
estado, consentimiento o autorización. Las tablas especiales de control,
identidad, custodia o presupuesto compartido requieren decisiones separadas.

El SQL adquiere locks de las tablas del catálogo y revalida el inventario,
propietarios, columnas, flags RLS, políticas y roles antes de cualquier DDL.
Los identificadores son cerrados y citados; un cambio o política previamente
instalada aborta toda la transacción. El corte requiere ejecución por el dueño
de migración y custodia exclusiva del DDL, además del catálogo fresco completo.

Los propietarios cerrados de cuotas y bootstrap conservan sus políticas propias:
no se genera una restricción PUBLIC universal que esconda consumo de otros
perfiles. Sus funciones, al igual que grants, vistas, FKs y consumidores, siguen
necesitando su revisión específica. Una propuesta de filas no equivale al cierre
global de esos controles ni prueba que los endpoints usen autoridad auténtica.
