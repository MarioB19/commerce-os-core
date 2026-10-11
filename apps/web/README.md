# Commerce OS web

Interfaz interna en español para el catálogo compartido y Ventas. React, TypeScript, Vite, Tailwind, componentes shadcn/Radix y TanStack Router/Query. No contiene datos de demostración incrustados: las pantallas consultan `/v1` y la sesión individual de Better Auth.

Desde la raíz del monorepo:

```sh
pnpm --filter @commerce/web typecheck
pnpm --filter @commerce/web build
pnpm serve:build
pnpm test:e2e tests/e2e/web.spec.ts
```

La aplicación local compilada se sirve en `http://127.0.0.1:5173`. La configuración y las credenciales locales se cargan mediante los scripts de la raíz desde almacenamiento privado externo al vault. La web usa cookies de sesión; no almacena tokens, sesiones de canal o credenciales en `localStorage`.

## Navegación

- Inicio: resumen del entorno, actividad y acceso al ciclo comercial.
- Productos y ofertas: catálogo compartido, versiones de oferta y archivos privados.
- Ventas: resumen, inbox, leads, pedidos y cobros, flujos y agentes, campañas de mensajes y canales WhatsApp.
- Campañas: metadatos de adquisición, anuncios, bindings históricos y preparación de conversiones.
- Resultados: métricas persistidas, embudo y evidencia de atribución; valores ausentes se muestran como desconocidos.
- Sistema: salud, roles, usuarios, tokens limitados, datos bancarios protegidos, políticas y controles operativos.
- Inteligencia y Estudio creativo: alcance futuro identificado como planificado.

Los entornos `SIMULATION` y `REAL` se consultan por separado. Cambiar de entorno desmonta las vistas y borra su selección temporal. Las capacidades dependen del rol; la API es quien autoriza cada acción. Los comandos guardados se observan hasta su aplicación o fallo. Aprobar un comprobante y conciliar un ingreso son operaciones distintas.

Desde Inbox → Venta y permiso, una aprobación pendiente muestra el paso y su contexto. Al guardar el motivo, la decisión se vincula a la versión y al nodo observados; si el flujo cambió, el servidor rechaza esa revisión.

El editor de flujos usa nodos tipados, conexiones, ramas y subflujos versionados. La publicación genera una versión inmutable. El simulador utiliza sus propios registros y reloj; crear un borrador o una simulación no habilita mensajes reales.

## Verificación del navegador

`tests/e2e/web.spec.ts` comprueba acceso individual, persistencia del catálogo, aislamiento de entornos, publicación de flujo, control humano, consentimiento y baja, importación, borrador/cancelación de campañas, navegación móvil y revisión/conciliación del pago y aprobación humana del nodo exacto. Los fixtures son sintéticos y los efectos usan el simulador. Las capturas se generan en `test-results/`; trazas y vídeo están deshabilitados para evitar registrar credenciales. La sesión se reutiliza sólo en memoria durante el proceso de prueba.

La medición de latencia durable→visible se mantiene separada en `tests/e2e/performance.spec.ts`. Los contratos y las limitaciones de proveedores están en `docs/contracts.md` y en la documentación de operación de la raíz.
