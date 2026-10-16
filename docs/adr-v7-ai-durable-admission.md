# ADR V7 — Credenciales, presupuesto e intentos de IA por perfil

Estado: implementación y verificación local, 2026-10-12. Transición 019 preparada. No montaje, claves reales, llamadas a modelos ni migración de producción.

## Autoridad y alcance

RF13/RF14 usan exclusivamente la credencial del negocio. La configuración de perfil y variante selecciona un modelo del catálogo protegido; una petición no puede aportar precios, endpoints ni credenciales alternativas. El contexto mantiene perfil, entorno, variante, conversación cuando exista, tarea y UUID de intento. Un grant explícito del negocio vincula ese contexto con una credencial estable y revisiones verificables. La rotación de la clave no crea otro saldo.

Las mutaciones de configuración se llaman dentro de la transacción interactiva F2 con `integrations:write`; la autoridad se relee antes del COMMIT. El adaptador de ejecución emplea un rol dedicado y transacciones breves por perfil. No retiene una transacción SQL durante el POST. El rol no recibe permisos sobre conversaciones ajenas, selección global ni mutación de configuración.

## Diario y contabilidad

Un intento pasa de RESERVED a INTENT antes de la red. El UUID, solicitud por hash, modelo/revisión/precio, grant, credencial/revisión, perfil y entorno quedan inmutables. Repetir reserve para la misma identidad devuelve ALREADY_ATTEMPTED, incluso tras un fallo anterior al POST; un conflicto no es reintentable. BeforeSend relee perfil ACTIVE, grant vigente, precio protegido, estado de credencial y su revisión, reserva y ventana. COMMIT debe confirmarse antes de permitir una única llamada.

El máximo se reserva contra los presupuestos explícitos del perfil y de la credencial. Se usa aritmética entera microUSD y reloj PostgreSQL. Se reserva en cada periodo protegido que intersecta la ventana máxima de 60 segundos; debe existir cobertura completa y no solapada. Esto evita reiniciar el saldo al cruzar una frontera. El presupuesto no es el de GCP y no usa créditos de plataforma. Un rechazo, fallo antes de red o resultado incierto conserva su reserva. Sólo un resultado SUCCEEDED con uso íntegro validado contra el precio original puede ajustar el cargo al coste medido. Nunca hay refund automático de un envío incierto.

El ledger expone `reservedMicrousd`, `chargedMicrousd` y `measuredCostMicrousd` nullable por separado. Los tokens input/output/cacheRead/cacheWrite/audioInput, priceVersion y fechas created/intent/settled UTC son trazables. F7 usa sólo coste medido como observación y cuenta por separado intentos y resultados inciertos; no convierte reserva o ausencia de uso en coste cero. Los eventos append-only conservan los cambios.

## Custodia y verificación mínima

La clave se cifra con AES-256-GCM y AAD de perfil, entorno, proveedor, credencial y revisión. La clave de cifrado se inyecta desde custodia confiable; no se busca en variables de proveedor ni se incluye en logs, respuestas o ledger. CredentialPort devuelve la clave sólo en RAM. La revisión se relee después de obtenerla.

Guardar una clave deja estado UNVERIFIED. La prueba mínima explícita usa tarea `credential.verify`, grant de prueba y el mismo presupuesto del negocio, con UUID idempotente y catálogo protegido. No se fabrica una variante comercial para esta prueba: el ledger lleva `is_test=true` y variante/conversación nulas. Sólo SUCCEEDED de esa revisión puede acreditar VERIFIED. Un intento incierto no autoriza repetirlo automáticamente ni acredita saldo disponible. La ejecución real de esa prueba requiere el montaje y la autorización del negocio; los fixtures sólo usan proveedores sintéticos locales.

Las causas de dependencia (clave ausente/rechazada/no verificada, presupuesto insuficiente, proveedor incierto) se guardan separadas de las pausas humanas. El consumidor debe mostrar la causa y derivar a persona/alerta; resolver la causa no elimina humanPaused ni repite un intento consumido. Las operaciones y lecturas de estado nunca devuelven secretos.

`ai_admission_denials` registra la primera causa cerrada de una reserva denegada, con la identidad de solicitud y grant. No es un gasto ni un intento enviado. `readAiDependency` conserva esa historia: un intento durable sólo permite reconciliar su resultado original; una dependencia resuelta exige una admisión nueva. Su resultado siempre lleva `clearHumanPause: false` y nunca constituye permiso de envío.

El catálogo `ai_model_prices` es una entrada protegida e inmutable. El rol de ejecución y la API sólo pueden leerlo; no pueden adoptar precios desde una petición. Las columnas tipadas, documento de modelo y fechas se comparan antes de usarlos. El adaptador rechaza ejecutarse dentro de otra transacción de perfil: cada reserva, INTENT y liquidación posee una transacción breve cuyo COMMIT debe confirmarse.

## Contrato de resultados y laboratorio

La vista `result_ai_cost_facts` usa `security_invoker=true` y conserva RLS. Expone perfil, entorno, conversación/variante, intento, proveedor/modelo/revisiones/precio/tarea, `operation_class`, fechas UTC, estado, coste medido y cinco cantidades de tokens. Omite reservas, ciphertext y solicitudes. Uso desconocido permanece NULL; cero sólo procede de uso completo validado. F7 debe excluir TEST de los resultados comerciales y mostrar incertidumbre separada.

En 019, `is_test` es exclusivamente la verificación mínima de credencial: UUID de la operación de guardado, solicitud fija por hash, variante/conversación nulas y presupuesto existente. No es una excepción genérica para RF19. El laboratorio requiere una extensión explícita para ligar su test run y snapshot a una credencial empresarial REAL ya VERIFIED, ejecutar en SIMULATION y clasificar el coste como TEST; no debe fabricar variantes/conversaciones comerciales ni copiar secretos para satisfacer estas FK. Esa extensión aún no se acredita aquí.

## Verificación y límites pendientes

Pasaron 57 pruebas unitarias (49 del adaptador y 8 de persistencia/custodia) y 22 casos PostgreSQL restringidos, con dos recorridos TCP de proveedor sintético local. Cubren RLS, scopes/entornos, reserva concurrente, límites por perfil y credencial, periodos cruzados, cargo incierto conservado, rotación/revocación entre acquire e INTENT, COMMIT incierto, uso/coste/precio original, prueba mínima idempotente, GCM y sobres cerrados. Los recorridos TCP acreditan COMMIT anterior al único POST y ausencia de un segundo POST al reutilizar el intento. Typecheck focal y ESLint pasan.

El intento PostgreSQL inicial conservó 2 PASS/16 FAIL por pérdida de milisegundos al convertir fechas PostgreSQL mediante `String(Date)`. Se corrigió la conversión sin relajar la igualdad; los ensayos posteriores conservaron 21 PASS y finalmente 22 PASS. Dumps y recibos originales permanecen privados. Se retiró únicamente cada contenedor propio, preservando exactamente cinco contenedores ajenos y 65 volúmenes. El typecheck global del árbol base 9ded8bf conserva un error previo de inferencia en `scripts/integration-test-groups.ts`; su anotación ya está corregida en la rama consolidada y no se modifica en este incremento.

El montaje API/workers, catálogo/precios y custodia nativos, UI/alertas finales y combinación real con las proyecciones 017 y aislamiento 020 siguen pendientes hasta evidencia propia. El puerto admite resultados del adaptador confiable; los fixtures no acreditan respuesta ni cobro de un proveedor real. Véase `docs/evidence/v7-ai-durable-admission-20261012/validation.json`.
