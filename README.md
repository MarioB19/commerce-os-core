# Commerce OS · Ventas

Aplicación web para catálogo, ventas por WhatsApp, cobros, entregas, campañas de mensajes y resultados. Catálogo, identidad e historial son compartidos. Inteligencia y Estudio creativo aparecen como Planificado. WhatsApp es un canal del módulo Ventas.

**Para preparar tu primera oferta:** [handbook general de Commerce OS](docs/first-offer-handbook.md), con 11 pasos, ficha de preparación, pantallas y checklist. [Campañas: periodos, cobertura e impuestos estimados](docs/campaign-filter-data.md).

El núcleo está publicado en [Commerce OS](https://commerce-os.inovaris.online). El entorno habitual es REAL; el laboratorio se abre explícitamente desde Configuración → Pruebas. La publicación de software conserva congeladas las acciones comerciales hasta contar con sus autorizaciones.

El código incluye catálogo compartido, ofertas y flujos versionados, comprobantes, entregas, campañas, adaptadores WhatsApp y proveedor IA configurable. El ingreso se acredita al validar el comprobante. El estado vigente, las pruebas y los pendientes de conexión, piloto, IA, monitor y respaldo externos se registran en [PROGRESS](docs/PROGRESS.md) y en [la matriz de cierre](docs/operational-closure.md); una prueba con fixtures no acredita integración remota. Credenciales y sesiones se guardan fuera del repositorio y del vault.

## Repositorio

**Para el próximo cambio:** [guía paso a paso de desarrollo y publicación](docs/publishing-changes.md). Incluye comandos, seguimiento del despliegue, recuperación de fallos y un texto listo para pedir una nueva implementación.

**CI/CD operativo y validado en producción.** La [ejecución 34074099013](https://github.com/MarioB19/commerce-os/actions/runs/34074099013) pasó pruebas, empaquetado e instalación automática del commit `03461af`. Se comprobaron respaldo cifrado nuevo, seis servicios sanos, 18 migraciones, paridad HTTPS y conservación de la infraestructura. [Evidencia productiva](docs/evidence/ci-cd-production-validation.json).

Código versionado en [MarioB19/commerce-os](https://github.com/MarioB19/commerce-os), con `main` como rama principal. [GitHub Actions](https://github.com/MarioB19/commerce-os/actions/workflows/ci.yml) verifica cada push y pull request; los cambios de aplicación en `main` despliegan automáticamente después de pasar las pruebas, con backup, hashes y comprobación productiva. No ejecuta operaciones comerciales. Secretos, sesiones, datos privados, reportes temporales y paquetes de despliegue quedan fuera de Git. Funcionamiento y recuperación: [guía CI/CD](docs/ci-cd.md).

## Iniciar

Requiere Node24.20.0, pnpm10.34.5 y Docker. Versiones exactas en package.json y pnpm-lock.yaml.

```sh
pnpm install --frozen-lockfile
pnpm local:setup
pnpm db:migrate
pnpm bootstrap
pnpm build
pnpm serve:build
```

Abrir [Commerce OS local](http://127.0.0.1:5173). `pnpm dev` inicia desarrollo con recarga. En este Mac, anteponer `~/.local/share/commerce-os-toolchain/node_modules/.bin` al PATH si el Node por defecto no es24.

El primer arranque genera acceso individual y secretos en `~/.config/commerce-os-local/runtime.env` (0600), fuera del vault. El correo y contraseña iniciales son BOOTSTRAP_EMAIL y BOOTSTRAP_PASSWORD; en este host también están separados en el archivo privado `~/.config/commerce-os-local/login.env`. El registro público está cerrado. No subir ese archivo al repositorio ni pegarlo en notas. Los archivos de cliente se cifran en el directorio privado. Las diez líneas iniciales son simuladas.

## Recorrido de uso

1. Productos y ofertas: crear producto, cargar enlaces/archivos privados/referencia de acceso, definir versiones de banco/política y condiciones de entrega. Una oferta guarda una versión concreta de cada dependencia.
2. Ventas → Flujos y agentes: duplicar plantilla, editar nodos, condiciones y subflujos, validar, simular con reloj virtual y publicar versión. Las ejecuciones anteriores conservan su versión.
3. Ventas → Canales: conectar una línea simulada. Una cuenta WAHA real necesita gateway aislado y escaneo autorizado; Cloud necesita configuración oficial y elegibilidad. El QR es temporal y autenticado.
4. Inbox: abrir conversación, verificar origen/oferta, registrar compromiso, tomar control o consentimientos/baja. Observar comandos APPLIED y salidas SENT/UNKNOWN; un202 únicamente acepta el trabajo.
5. Pedidos y cobros: adjuntar comprobante privado, revisar el documento y luego conciliar con evidencia financiera. Aprobar el comprobante no declara que el dinero llegó. Las entregas Core/beneficio/pago dependen de la oferta.
6. Campañas de adquisición: importar metadatos Ads y bindings vigentes. Seguimientos y mensajes: previsualizar segmentos/exclusiones y preparar campañas gobernadas por autorización. Son entidades diferentes.
7. Resultados: consultar cohortes por fecha/oferta/cuenta/agente/fuente, conciliación por moneda y evidencia. SIMULATION y REAL nunca se suman. Sin gasto comparable, ROAS queda sin calcular.

## Servicios

| Servicio | Puerto local | Responsabilidad |
|---|---|---|
| web |5173|React/Vite; sesiones y API persistida|
| api |3001|Fastify/BetterAuth; catálogo, permisos, controles y comandos|
| ingress |3002|Autenticar y persistir envelope cifrado antes de ACK|
| automation-worker |3003|Flujos, timers, IA, cobro y proyecciones; propone efectos|
| channel-worker |3004|Lifecycle/ownership, medios y único despacho externo|
| PostgreSQL |5440|Hechos de negocio, inbox/outbox, versiones, auditoría; pg-boss reconstruible|

Runtime de producción: contenedores independientes, roles de base por servicio, colas en schemas separados y objetos privados. Locks cortos; IA/HTTP fuera de transacciones. UNKNOWN no se reenvía automáticamente; un lease vencido no autoriza apropiarse de una sesión.

## Verificación reproducible

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:load
pnpm test:recovery
```

Integración/carga/recuperación crean bases aisladas con PostgreSQL real y sólo datos sintéticos. Los fallos conservan la base para diagnóstico. E2E usa assets/build de producción y Chromium; instalarlo con `pnpm exec playwright install chromium`. La evidencia final, límites y fallos corregidos se registran en [verificación](docs/verification.md); no sumar ejecuciones repetidas como más cobertura.

## Documentación y release

- [Matriz RF01–28](docs/requirements.md): implementación, verificación local, integración real y habilitación separadas.
- [API y ejemplos](docs/api.md), [contratos](docs/contracts.md), [adaptadores y fuentes](docs/provider-integration.md).
- [Automatizaciones API-first](docs/api-automation.md), [Meta de lectura](docs/meta.md) y [diagnóstico QR](docs/qr-audit.md).
- [Operación, incidentes y recuperación](docs/operations.md), [inventario VPS leído](docs/vps-readonly-inventory.md).
- [Paquete de despliegue y rollback](docs/release-review.md). Instalación y HTTPS públicos verificados en commerce-os.inovaris.online.

No existe ejecución comercial autónoma por una salida libre de IA. Las reglas deterministas, permisos y autorizaciones vigentes gobiernan las acciones externas.
