# Ventas: flujos visuales y vendedor contextual

H0–H5 integrados y publicados con números e identidad en `637a94c`. La migración de Ventas quedó como `0022_sales_visual_seller.sql`, conservando las 21 anteriores. [Evidencia productiva](evidence/integrated-production-publication.json). [Decisiones de integración](adr-integrated-publication-2026-09-07.md).

La revisión aislada y sus resultados descritos a continuación corresponden a la entrega local histórica `2a7e1b2`; sus fixtures no se copiaron al catálogo REAL.

## Abrir la revisión

La instancia aislada está en [localhost:5273](http://127.0.0.1:5273/sales/flows). Worktree: `/Users/example-user/.local/share/commerce-os-worktrees/sales-visual-seller`. Acceso local en `/Users/example-user/.config/commerce-os-sales-visual/login.env`, fuera de Git/vault; no copiar sus valores a notas, capturas o tickets.

La base `commerce_sales_visual_20260907` contiene fixtures sintéticos. API/ingress/automation/channel usan 3101–3104; web 5273. La instancia ajena de 5173/3001–3004 no se detuvo. REAL permanece congelado. Las pruebas no usan WhatsApp, QR, credenciales de proveedor ni llamadas pagadas.

Si la instancia se detiene, abrir una terminal **en este worktree**:

```sh
export PATH="$HOME/.local/share/commerce-os-toolchain/node_modules/.bin:$PATH"
export COMMERCE_CONFIG_DIR="$HOME/.config/commerce-os-sales-visual"
export E2E_BASE_URL="http://127.0.0.1:5273"
pnpm serve:build
```

No iniciar un segundo supervisor si 5273 ya está ocupado por esta revisión. `pnpm build` regenera los archivos compilados después de editar; terminar únicamente el supervisor de esta carpeta y volver a arrancarlo. La configuración privada selecciona la base, claves y puertos aislados.

## Recorrido de revisión de 10 minutos

1. Entrar a Ventas → Flujos y agentes. Buscar **Preescolar · conversación y comprobante**. Es una copia local basada en `preschool-launch.md`: 360 actividades, ocho bonos y oferta base $97 MXN. La categoría es propuesta; no se inventaron temario, garantías o descuentos. **Fotografía · recorrido ficticio** comprueba otro producto, con oferta ficticia $25 MXN.
2. En el mapa, buscar **¿Necesita ayuda?**. La selección se centra y el inspector recibe foco. Recorrer las salidas Sí/No; cambiar a **Pasos** conserva el mismo grafo. Mover un bloque con arrastre o los botones de posición modifica sólo las coordenadas. `Autoorganizar` conserva la ejecución.
3. Elegir una conexión → tipo → **Insertar aquí**. Confirmar el cambio A → nuevo → B. Editar mensaje, minutos o condición con sus formularios. También se puede arrastrar un tipo de la biblioteca sobre el mapa/conexión. Eliminar un paso anuncia conexiones afectadas; **Deshacer** restaura parámetros y aristas. Mover antes/después sólo se ofrece para tramos lineales válidos.
4. Esperar **Borrador guardado**, cambiar de paso y recargar. El texto y selección continúan. Un borrador incompleto se guarda; **Validar** explica los pendientes y lleva al nodo. Probar o publicar una versión interna exige validación completa. Las publicadas son de lectura: crear una revisión o copia para editar.
5. Abrir Vendedores → **Lía · Preescolar (prueba)**. Recorrer Qué vende / Qué sabe / Cómo responde / Cuándo pide ayuda / Probar y revisar. Categoría/conocimiento se editan en el catálogo compartido. Guardar conocimiento y vendedor son acciones distintas y visibles. El conocimiento sin guardar y las instrucciones avanzadas sobreviven al cambiar de sección. Se exige guardar el conocimiento antes de cambiar de producto o crear otra revisión del vendedor. Guardar el vendedor crea otro ID/revisión; no reasigna conversaciones existentes.
6. Volver al flujo → **Probar conversación** → **Iniciar prueba**. En Preescolar escribir `segundo`, después `¿Qué incluye?`, `¿Y eso?` y `precio`. Inspeccionar las fuentes y el historial. `Quiero una persona` suspende la prueba; la aprobación de prueba devuelve al requisito anterior. `baja` la detiene. Reiniciar para otro escenario.
7. En **Escenarios y reloj virtual**, simular comprobante pendiente/aprobado o avanzar minutos. Son decisiones ficticias, sin venta, archivo entregado ni gasto. El panel identifica revisión y nodo; fuentes y recorrido se inspeccionan en un detalle. **Evaluar proveedor externo** explica la dependencia deshabilitada.
8. Abrir un subflujo publicado mediante **Abrir subflujo** y volver por el enlace al padre: recupera el paso y filtros. Desde Catálogo o Conversación, los enlaces abren el producto/flujo/vendedor correspondientes. La ficha de conversación muestra la revisión y origen reales del vendedor.

**Conflictos y fallos:** si otro editor guarda, la API rechaza la revisión esperada y conserva el borrador en memoria; se puede guardar como copia o descargar para comparar. Una red caída conserva los cambios y permite reintentar la misma intención. Cambiar de entorno o salir con cambios pendientes requiere resolver el borrador. Recargar antes de guardar usa la protección del navegador; no hay promesa de recuperar memoria tras cerrar forzosamente el proceso. JSON avanzado inválido se conserva por nodo y bloquea el guardado hasta corregirlo.

## Contratos y comportamiento

[Contratos comunes](contracts.md) y OpenAPI servido por la aplicación incluyen las rutas nuevas. `editor` es opcional, versión de esquema 1, con posiciones y etiquetas; no altera `next`, `branches` ni los límites de 100 nodos y grafo acíclico. Se conserva el contenido declarativo API-first que el inspector no muestra. Borradores validan tipos/tamaño/prohibición de código y referencias presentes; publicación/evaluación validan todo el grafo y subflujos publicados.

Categoría opcional y fuentes del producto usan `record_versions`. Un vendedor tiene familia, revisión y referencia a su versión anterior. Un segundo sucesor concurrente de la misma versión se rechaza. El origen efectivo compartido por API y worker es **vínculo → oferta → número → producto → workflow**. El workflow sólo aporta un respaldo final nuevo; no cambia precedencias existentes. La UI distingue vista previa de catálogo del origen definitivo de la conversación/número.

Cada conversación nueva fija snapshot de oferta, producto, categoría y vendedor. Conversaciones anteriores sin snapshot recuperan las revisiones de catálogo disponibles a su fecha de creación y las fijan al primer uso; una fuente histórica inexistente no se sustituye por hechos nuevos. Contexto: hasta 12 mensajes / 6000 caracteres, fuentes hasta 12000 caracteres, mensajes individuales saneados y variables de texto limitadas a `grado`, `nivel`, `necesidad`, `objetivo`, `interes`, `modalidad`. Estado del pedido y etapa proceden del servidor. Se omiten enlaces, números extensos, secretos reconocibles y mensajes de cobro/medios protegidos. Esto es minimización, no un detector universal de datos sensibles.

El servidor comprueba que las citas pertenecen al contexto y rechaza precios/monedas incompatibles y afirmaciones comerciales no verificadas. Conflictos de producto/oferta y afirmaciones monetarias en conocimiento solicitan revisión. Citas válidas no demuestran todas las afirmaciones posibles; la calidad semántica del proveedor externo sigue sin evaluar.

El flujo consume respuestas esperadas y tiene prioridad sobre el vendedor por mensaje. Las preguntas durante esperas no aprueban compromiso/comprobante. Tras ayuda humana o error del proveedor se conserva la espera original; el reloj no avanza a escondidas. Resultados tardíos se descartan por secuencia, etapa, estado del flujo, controles o configuración. La revisión humana existente sigue gobernando las decisiones comerciales.

`receipt_sales_v1` sigue reconociendo el ingreso desde comprobante validado. Prueba/Falso y restauraciones mantienen su proyección e idempotencia. `reconcile` sólo conserva compatibilidad histórica; no se añade a la biblioteca ni se vuelve requisito para ventas nuevas. La entrega de legado ya conciliado permanece compatible, sin recalcular resultados históricos.

La evaluación guarda snapshot inmutable y estado en `flow_evaluation`: nunca inserta conversaciones, pedidos, mensajes, comandos, outbox o temporizadores comerciales. Copia campos declarativos permitidos y saneados; excluye payloads privados y archivos. Usa condiciones, renderizado y composición de contexto compartidos, con intérprete y reloj puros; los fixtures comprueban transiciones, no conectividad ni calidad lingüística. `POST /evaluations/:id/provider` siempre devuelve `409 PROVIDER_EVALUATION_NOT_ENABLED`. `SIMULATION_EXTERNAL_AI_DENIED` se conserva.

## Verificación

[Resultados y límites de esta entrega](evidence/sales-visual-verification.json), [QA responsive](evidence/sales-visual-browser.json), [zoom nativo](evidence/sales-native-zoom.json), [recuperación](evidence/recovery.json). 73 unitarias, 134 integraciones y una QR optativa omitida; 29 escenarios E2E distintos verificados. La suite completa terminó con 28 aprobados y una expectativa obsoleta de Catálogo; ese caso pasó después junto con los siete escenarios nuevos. Se repitieron dos recorridos tras el último ajuste de conocimiento/asignación. El informe conserva esta secuencia: no se atribuye una suite completa limpia ni se suman reintentos. Siete pruebas Python, recuperación, typecheck/lint/build y auditoría correctos.

Para reproducir con el entorno anterior:

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
pnpm test:recovery
python3 -m unittest discover -s tests/ci -p 'test_*.py'
pnpm test:e2e
pnpm audit --audit-level high
node scripts/verify-sales-native-zoom.mjs
```

Los E2E existentes admiten `E2E_BASE_URL` e `INGRESS_PORT`; los defaults de CI siguen siendo 5173/3002. La prueba de Campañas usa `campaign-demo.json` privado creado por su fixture; sus importes son sintéticos. `scripts/seed-sales-visual-review.ts` prepara los dos ejemplos en esta base, con operaciones API idempotentes. La prueba de recuperación restaura categoría, fuentes, vendedor, mapa y snapshot de evaluación, además de los controles y comprobantes anteriores.

Capturas sanitizadas: [mapa](evidence/screenshots/sales-map-1440.png), [configuración del vendedor](evidence/screenshots/sales-seller-config.png), [vendedor y prueba](evidence/screenshots/sales-seller-test.png), [Pasos a 360 px](evidence/screenshots/sales-review-mobile.png), [zoom 400%](evidence/screenshots/sales-native-zoom-400.png). Son fixtures locales, sin clientes, credenciales, QR ni enlaces privados. El zoom se comprobó con `chrome.tabs.setZoom/getZoom`, no con CSS ni sólo reduciendo viewport ([API oficial](https://developer.chrome.com/docs/extensions/reference/api/tabs), [Chromium y extensiones en Playwright](https://playwright.dev/docs/chrome-extensions)).

## Pendientes concretos

- **Lector de pantalla humano:** no se ejecutó una sesión auditiva con VoiceOver/NVDA. Antes de afirmar conformidad completa, recorrer menú, Mapa/Pasos, búsqueda, inspector, diálogo de inserción, error de validación y log de conversación; verificar nombre/rol, orden y anuncio de cambios. Axe, teclado, contraste automático, movimiento reducido y zoom no sustituyen esa revisión.
- **Proveedor externo:** falta una evaluación autorizada con configuración/presupuesto propios y corpus aprobado, incluyendo hechos sin fuente, objeciones, precios y resistencia a instrucciones maliciosas. No hubo llamadas pagadas ni se atribuye calidad del proveedor al doble determinista.
- **Revisión de contenido:** confirmar categoría y completar conocimiento real aprobado de Preescolar, especialmente políticas/objeciones faltantes. Los dos ejemplos son copias locales.
- **Integración/publicación:** revisar la rama y resolver expresamente la incorporación del incremento independiente de canales si se desea. Sin push, merge, CI remoto, empaquetado productivo ni despliegue en esta entrega. Publicación posterior sólo por el CI/CD vigente y nueva instrucción de Brandon.
- El bundle principal supera el aviso orientativo de 500 kB de Vite. El mapa de 100 nodos tiene medición local; no se acredita rendimiento móvil real, WAN o diez sesiones productivas. Fragmentar rutas puede tratarse como optimización posterior.

Implementado y verificado localmente se distingue de integrado con proveedor y habilitado operativamente: estas dos últimas condiciones no están acreditadas por la entrega.
