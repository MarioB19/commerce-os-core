# Piloto real de Inteligencia · ejecución recuperable

`scripts/creative-intelligence-pilot.mjs` usa exclusivamente la API humana publicada de Commerce OS. No llama directamente a SearchAPI/OpenAI, no importa `.env` de infraestructura y no escribe en PostgreSQL. La autorización es `DELEGATED_PILOT`, solicitud de Brandon del 08-sep-2026 y límites de `creative-pilot-costs.md`.

El piloto real terminó el 08-sep-2026 sobre `5e4747f373ce0a9eb8925c73c3153f863550c92f`, después de CI34266473591 SUCCESS, artefacto SUCCEEDED y comprobación del VPS. Las cuatro búsquedas BR/MX produjeron146 observaciones con cobertura PARTIAL; se completaron20 análisis de texto. Se observaron7 operaciones SearchAPI y20 OpenAI. El primer refresh viajó por el MCP STDIO instalado, con el token mínimo del propietario y sin una llamada adicional. Evidencias: `docs/evidence/creative-v1/intelligence-pilot.json`, `intelligence-mcp-refresh.json` y `deployment-34266473591-verified.json`.

OpenAI contabilizó USD0.086581 y40,770 unidades. SearchAPI registra7 unidades y mantiene USD0.028 reservado, con USD0 liquidado en el ledger: esa reserva no se presenta como factura confirmada ni como consumo gratuito. El seguimiento sigue OFF y las revisiones editoriales/producción PENDING. Los análisis sólo cubrieron texto; no acreditan revisión de imagen, audio o vídeo. La preparación sin llamadas permanece como antecedente del journal privado.

## Preparar

```sh
node scripts/creative-intelligence-pilot.mjs --prepare
```

El plan contiene cuatro búsquedas: planeaciones de primaria y oraciones/espiritualidad, cada una en BR y MX. Cada búsqueda tiene dos páginas y hasta 100 anuncios. Se eligen hasta cinco ofertas por búsqueda, con un máximo de 20 análisis. El seguimiento queda apagado. Los topes son ocho llamadas SearchAPI (USD0.032 teórico), OpenAI USD2 y 1,260,000 unidades conservadoras del broker.

## Ejecutar después de verificar el despliegue

Desde la raíz del repositorio, con sesión humana administradora autorizada:

```sh
node scripts/creative-intelligence-pilot.mjs \
  --execute-pilot \
  --configure-providers \
  --authorize-budgets \
  --login-env "$HOME/.config/commerce-os-production/login.env"
```

Por defecto apunta a `https://commerce-os.inovaris.online`. `--origin` sólo admite un origen HTTPS sin credenciales, ruta ni parámetros; debe coincidir con `BETTER_AUTH_URL` del login. El archivo privado de login usa `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` y `BETTER_AUTH_URL`. Los secretos de proveedores se leen de `~/.config/commerce-os-creative/searchapi.key` y `openai.key`. Todos requieren modo0600; no se imprimen ni se almacenan en Git o en el journal. Los secretos se transmiten únicamente al endpoint cifrado de configuración.

`--configure-providers` y `--authorize-budgets` son explícitos y separados. Omitirlos conserva la configuración existente; antes de pagar, el ejecutor exige proveedores habilitados y presupuestos vigentes que no superen los límites del piloto. Antes de habilitar proveedores se comprueba que no hay seguimiento activo ni runs ajenos pendientes, y se establecen los presupuestos acotados. La actualización fija límites absolutos del presupuesto existente, sin sumar crédito a consumos previos. La API rechaza reducir por debajo de reservas/consumos comprometidos.

Para un token humano `cosp_` ya autorizado, usa `--token-file /ruta/privada/token` y omite los dos flags administrativos. Los permisos de configuración y presupuesto requieren sesión humana. No se crea ni modifica ninguna contraseña, cuenta, campaña o envío.

## Reanudar y consultar

El estado y las respuestas completas viven en `~/.config/commerce-os-creative/intelligence-pilot-v1/state.json` (0600), con un lock local que impide dos ejecutores simultáneos. Cada intención guarda su clave de idempotencia y payload sin secretos **antes** del request. Una respuesta perdida se reintenta con la misma clave y versión. `UNKNOWN` pausa el piloto: reanudar consulta la misma ejecución, sin crear otro refresh o análisis. Un estado pendiente que supera diez minutos también pausa y conserva todos los IDs. Se pueden ajustar `--poll-seconds` (1–60) y `--timeout-seconds` (1–3600).

Repite exactamente los argumentos y el mismo `--state-dir` para reanudar. No borres el journal para resolver un recibo incierto ni cambies a otra identidad/origen: eso pierde la continuidad de operaciones y el ejecutor lo rechaza. Las búsquedas reutilizadas se comprueban por contenido y seguimiento apagado.

El informe público incluye IDs de búsquedas, runs y operaciones de proveedor, cobertura, conteos, modalidades y hashes de resultados. No incluye texto de anuncios/análisis, cookies, datos de login o claves. Los presupuestos antes/después son totales del workspace; actividad simultánea podría afectar su diferencia. No se presentan como factura individual ni se inventa consumo confirmado. La revisión editorial y aprobación de producción permanecen PENDING.

## Verificación sin proveedores

```sh
node --test scripts/tests/creative-intelligence-pilot.test.mjs
```

Diez pruebas pasan: plan/límites, prepare sin red ni credenciales, API simulada en serie y 20 análisis como máximo, respuesta perdida y reanudación con idéntica idempotencia, pausa UNKNOWN sin repetir pago, separación de secretos, permisos/origen del login; lock/identidad del journal; rechazo de tracking activo/presupuestos amplios antes de configurar credenciales; y diagnóstico de login sin textos sensibles. Estas pruebas no acreditan llamadas reales a los proveedores.
