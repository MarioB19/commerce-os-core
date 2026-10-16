# F2 — bases independientes para fixtures de transición

Decisión del 11-oct-2026, antes del cambio. Los ensayos de transición crean
schemas provisionales y algunos activan RLS en tablas históricas dentro de su
base sintética. El runner previo compartía una base entre todos los archivos:
ejecutarlos individualmente pasaba, pero agruparlos encontraba `profiles` ya
creado o alteraba los supuestos de la siguiente suite. Eso no acredita el gate
completo de integración.

El runner consulta primero la selección nativa de archivos de Vitest con
`list --filesOnly --json`, que no importa ni ejecuta sus tests. Conserva los
filtros y opciones de CLI, incluidas exclusiones explícitas. Particiona esa
selección: un grupo para las pruebas existentes y una base por cada archivo
`tests/integration/profile-*.test.ts`. Comprueba que todos los archivos elegidos
aparecen exactamente una vez. Cada grupo aplica las mismas migraciones
históricas completas; no se salta ninguna prueba ni se cambia un timeout.

En la variante F2 histórica, los procesos son secuenciales. Una base sólo se elimina después de PASS; ante
fallo se conserva y el runner sale con error, sin afirmar que los grupos
restantes hayan pasado. Los ensayos no borran datos de otra base ni necesitan
reiniciar Docker. Este cambio pertenece exclusivamente a la rama F2; el
candidato público y sus imágenes durante el FULL permanecen intactos.


## Composición con F0 y las transiciones F3/F4 · 12-oct-2026

El runner integrado conserva la enumeración nativa de F2 y aísla también el
calendario MCP de F0, que corre al final en su propia base. Los dos archivos
exactos continuous-authorization.test.ts y market-variants.test.ts reciben una
base cada uno; los nombres similares no adquieren aislamiento por inferencia.
Los grupos posteriores continúan ante un exit code no cero, conservando el
primer fallo y la base fallida. Una excepción aborta y cierra la conexión de
administración. Así un PASS posterior nunca borra el fallo previo. Todas las
selecciones aparecen una vez y los filtros originales permanecen activos.

## Extensión F3/F4 del 12-oct-2026

Antes de integrar las nuevas transiciones, se añaden exclusivamente
`tests/integration/continuous-authorization.test.ts` y
`tests/integration/market-variants.test.ts` a las suites con base independiente.
Ambas instalan el esquema de perfiles y su transición aditiva (010 u 008), por
lo que compartir base invalidaría sus precondiciones. La selección nativa,
los filtros, las exclusiones y la comprobación de partición completa siguen
siendo los mismos. Otros nombres parecidos no se aíslan por coincidencia
parcial. El cambio no modifica ningún candidato ni ensayo FULL en curso.

## Mantenimiento de vencimiento · 12-oct-2026

`expired-effects.test.ts` instala 001/013 y requiere una base propia por el mismo
contrato. Se añade su nombre exacto, conservando filtros, calendario al final y
partición sin omisiones. La anotación `calendar: string[]` corrige la inferencia
literal de TypeScript sin cambiar selección. Doce pruebas de partición pasan.

## Roles globales de transiciones — 12-oct-2026

Una base por archivo no aísla los roles del clúster PostgreSQL. Las transiciones
011/019 rechazan correctamente un rol previo, por lo que un segundo grupo puede
fallar si el primero deja su rol después de borrar su base. El harness captura
roles y membresías después de las migraciones históricas y antes de cada suite.
Sólo tras PASS valida que los roles preexistentes sigan iguales, que los nuevos
pertenezcan a la lista explícita de transiciones revisadas, no tengan membresías,
login, privilegios administrativos ni configuración, y que sus dependencias
pertenezcan exclusivamente a la base sintética propia. Recién entonces borra la
base; comprueba ausencia de dependencias y retira esos roles con un único
`DROP ROLE` sin CASCADE, verificando la restauración exacta de la baseline.

Un fallo de suite conserva su base y roles. Un drift o dependencia extranjera
falla cerrado antes de la eliminación. No se usa DROP OWNED, no se relajan los
guards de las transiciones ni se modifica ningún rol preexistente. La prueba
nativa ejecuta dos instalaciones reales consecutivas de 019 con el mismo
clúster, haciendo que ambas vuelvan a crear su propio rol. No sustituye los
casos funcionales del ledger IA ni acredita un FULL nativo.

La integración de 021 incorpora únicamente sus roles `commerce_number_lab` y
`commerce_number_lab_owner` con el atributo INHERIT verdadero que declaran sus
fuentes revisadas. El motor separado y sus futuros roles requieren otro cierre;
ningún nombre se incorpora por prefijo. Una regresión rechaza el mismo nombre
con atributos distintos. Las doce pruebas Python de orquestación pasan.

## Contratos Chromium dentro de la etapa E2E

El catálogo `scripts/browser-contracts.mjs` ejecuta trece harnesses explícitos de
perfil, invitaciones, continuidad, variantes, pagos y resultados en serie dentro
de `test:e2e`. Son pruebas de componentes con HTTP sintético en loopback; no se
atribuyen como montaje real. A continuación permanece la suite Playwright
original y sus filtros, y la sanitización corre también tras un fallo. El primer
error se conserva aunque las pruebas posteriores pasen. No cambia la lista de
veintiuna etapas del verificador ni reemplaza ninguna aserción existente.

Cinco pruebas Node verifican la secuencia, existencia/selección exactas,
propagación del fallo, conservación de filtros y sanitización en error de spawn.
El peer independiente las repitió. Esto acredita la composición del runner; los
recibos Chromium de cada componente siguen separados hasta el próximo FULL.
