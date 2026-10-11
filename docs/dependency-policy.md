# Dependencias y fuentes

Versiones fijadas tras consulta del registry npm y documentación oficial. `dependency-versions.json` registra versiones y peers; pnpm-lock.yaml fija transitivas. Node 24.20.0, pnpm 10.34.5. TypeScript 6.0.3 se elige frente al 7 publicado porque typescript-eslint declara soporte <6.1; Vitest 4.1.11 conserva compatibilidad con Better Auth. Ningún cambio implica compra.

Fuentes: [Node LTS](https://nodejs.org/en/download), [Vite](https://vite.dev/guide/), [Fastify LTS](https://fastify.dev/docs/latest/Reference/LTS/), [Better Auth/Fastify](https://better-auth.com/docs/integrations/fastify), [Drizzle/PostgreSQL](https://orm.drizzle.team/docs/get-started/postgresql-new), [pg-boss](https://pgboss.io/), [versiones PostgreSQL](https://www.postgresql.org/support/versioning/).

PostgreSQL 17.11 mantiene la rama 17 documentada en diseño con parche vigente observado. Imagen Node24 bookworm slim. Validación de imágenes, audit y contratos queda registrada en evidencias; una versión declarada no demuestra compatibilidad hasta ejecutarla.

El frontend estático usa Caddy 2.11.4, fijado según la [versión oficial](https://github.com/caddyserver/caddy/releases/tag/v2.11.4). Se retira la file capability de su binario porque escucha en 8080 como UID 1000 con capacidades Linux eliminadas. La compatibilidad se verifica en el ensayo de Compose.

El target de mantenimiento incorpora únicamente el binario de Docker CLI 29.8.0 desde su imagen oficial. La versión está documentada en las [notas oficiales de Docker Engine 29](https://docs.docker.com/engine/release-notes/29/). El socket Docker se monta sólo durante una tarea administrativa explícita; ningún servicio de negocio recibe ese acceso.

El editor de Ventas añade `@xyflow/react` **12.11.6**, fijado en package.json y lockfile, sobre React existente. [Accesibilidad](https://reactflow.dev/learn/advanced-use/accessibility) y [arrastre](https://reactflow.dev/examples/interaction/drag-and-drop) se complementan con vista Pasos y controles sin arrastre. Compatibilidad comprobada con typecheck/build/E2E; no se sustituye la validación del motor por la librería.
