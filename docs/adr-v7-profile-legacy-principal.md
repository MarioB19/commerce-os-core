# F2 — compatibilidad de identidad por acción

Decisión previa al código, 12-oct-2026. El middleware global de la integración
consolidada pertenece a F0. Este módulo puro prepara la conversión de una
ProfileAuthority ya resuelta dentro de su transacción a Principal legacy.
No selecciona una membresía, no recibe bearer, no lee SQL y no monta rutas.

La conversión exige una acción V7 exacta y vuelve a comprobar identidad,
perfil, membresía, revocación, caducidad, rol y scopes. Un PAT conserva el rol
real de su membresía; nunca obtiene Owner por ser PAT. Las identidades de
plataforma se rechazan y conservan su futura frontera independiente. Las
credenciales personales necesitan su token ID nativo para la identidad de
idempotencia; las sesiones no aceptan ese campo.

El Principal sólo lleva el scope de la acción y los aliases explícitos que
esa ruta haya solicitado de un catálogo cerrado de pares. No se emiten `*`,
`read` ni la unión de permisos de todo el rol. Aliases ambiguos como
`imports:write` y `reports:export` permanecen rechazados hasta documentar su
acción de negocio exacta. No hay fallback de un scope faltante a uno amplio.

Un alias histórico como `catalog:read` no distingue productos de materiales.
Por eso este objeto es válido exclusivamente para el handler cuya acción y
entorno se autorizaron, bajo el ejecutor transaccional y el control final de
autoridad de F0. No se puede usar como credencial reutilizable entre rutas.
Las ramas legacy basadas sólo en role también necesitan esa autorización
previa de ruta, no adquieren autoridad por el objeto. El inventario exhaustivo
de handlers, límites, RLS y workers sigue siendo requisito de montaje.

Se copia y congela la identidad, acción, entorno y arrays para que una mutación
posterior del input no amplíe el Principal. La función falla ante combinaciones
no documentadas y preserva IDs textuales de perfil sin normalización.
