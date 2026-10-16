# V7 — Clasificación de filas del esquema compuesto

Fecha: 2026-10-12. Estado: preparación local; sin DDL nativo.

La clasificación enumera cada tabla pública y privada por identidad exacta del
esquema compuesto hasta027 (39 fuentes SQL). Un objeto nuevo, ausente o repetido bloquea la
composición; no se deduce autoridad a partir de nombres, columnas o grants
encontrados. Las FK y los roles, funciones privilegiadas, vistas, triggers, ACL
y montaje tienen verificaciones adicionales antes de cualquier corte.

Las tablas comerciales tienen perfil y entorno. La autoridad compartida por
perfil —membresías, invitaciones, configuración, tokens— usa sólo el perfil;
`profiles` utiliza su id textual. El conjunto de roles de aplicación es explícito
y no incluye propietarios de puertos cerrados. Agregar una política no concede
privilegios SQL. El lector creativo mantiene REAL+SIM y el dueño de cuota mantiene
su agregado global a través de las políticas específicas ya revisadas.

RLS activo conserva sus políticas permisivas: en particular READY, consentimiento
y estados no se convierten en acceso incondicional. Sólo una tabla con RLS
originalmente deshabilitado recibe la política permisiva de ámbito junto con la
restrictiva. El planificador coteja metadata completa bajo locks antes del DDL.

Se preservan expresamente:

- La identidad autenticada global y el catálogo de precios. Requieren frontera
  de identidad/administración separada; no son datos comerciales de un perfil.
- Las políticas de cuota global y de pausa manual de workspace. Se exige que
  sus componentes ya tengan RLS forzado; no se les añade un filtro de entorno
  que esconda otras cuotas o una pausa global.
- Los dispositivos retirados, sólo después de comprobar la política restrictiva
  falsa exacta y RLS forzado de020. No se inventa entorno ni perfil para pairing.
- El control privado021 del laboratorio. Sus dimensiones source/budget REAL y
  execution SIMULATION tienen significado distinto; sus claves y guards se
  preservan. Las bases motor del laboratorio no forman parte de este catálogo.

Una clasificación completa es un prerrequisito, no una certificación de
aislamiento. La lectura nativa, el ensayo compuesto con datos, los accesos por
roles reales y el montaje completo permanecen obligatorios.

## Ensayo de identidad compuesta

El ensayo posterior de12 casos instala las39 fuentes y el plan RLS real en
PostgreSQL17.11. Un login restringido, miembro sólo de commerce_api, recorre
bootstrap sin perfil seleccionado, CAS de selección, autoridad de sesión y PAT
fijo, ambos entornos, revocación y vencimiento durante escritura. No sustituye
la autenticación HTTP de Better Auth ni el montaje de los consumidores. Las
funciones privilegiadas y ACL globales conservan su revisión separada.
