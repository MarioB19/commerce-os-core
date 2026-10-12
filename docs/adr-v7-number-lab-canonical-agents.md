# RF19 — fases del vendedor canónico en la base del laboratorio

Decisión previa, 12 de octubre de 2026. `processAgents` conserva su entrada y
sus dependencias comerciales. Una implementación privada admite únicamente el
puerto SQL del lease instalado de laboratorio y un vendedor opaco emitido por
la composición protegida del driver. La acción pública no puede suministrar
pools, modelos, grants ni callbacks. No se cambia el kernel de transacciones ni
la rama de análisis de comprobantes.

El vendedor fijado al run/operación/snapshot/release valida además la conversación,
cuenta, oferta y agente remapeados por el materializador. Cada fase SQL mantiene
la autoridad de control hasta el COMMIT del motor. PREPARE crea el `ai_run`
canónico; su UUID es el intento 019/021. Antes del INTENT del proveedor vuelve a
leer controles, contexto y configuración en una fase corta y confirmada; después
019/021 revalida clave, permiso y run. No existe transacción abierta durante IA.

RECONCILE reutiliza el mismo grounding, opt-out, entrega a revisión, continuidad
del workflow y deduplicación de efectos. Conserva el recibo de IA con uso/precio
nativos y microUSD, nunca costos comerciales inventados. Una respuesta incierta
no permite volver a llamar al proveedor. Si no puede reconciliarse por pérdida de
autoridad, el ledger conserva costo/estado; no se atribuye un mensaje aplicado.
Los grants siguen siendo configuración protegida por perfil y variante; este
incremento no inventa una aprobación ni acredita todavía su montaje API.

El marcador heredado `isolation.external_network:false` describe los transportes
y el almacenamiento del motor dedicado: sus roles no leen credenciales ni
operan canales reales. La red de IA pertenece al puente externo 019/021 y el
recibo del driver la declara por separado como `ai_network:PROFILE_AI_ONLY`.
`external_effects:0` conserva su significado de mensajes/efectos comerciales
reales; no afirma ausencia de gasto o peticiones a IA. Las pruebas usan respuestas
sintéticas, y el montaje debe imponer físicamente la separación de egress.

El recibo separa fase procesada del resultado: `ai_result` lee del registro
canónico el UUID, estado, estado nativo del proveedor y revisión humana. Una
fase `APPLIED` puede haber terminado en `FAILED`/`UNCERTAIN`; la respuesta no
atribuye éxito por haber completado una transacción o agotado la fase.

## Reutilización de propuesta después de una pausa

El resultado pagado no es una autorización vigente. Un nuevo puerto cerrado del
componente 021 verifica el intento SUCCEEDED y su binding inmutable contra el
run, snapshot, variante, release, grant y solicitud semántica originales. La
operación actual debe estar INTENT; la operación que pagó el resultado permanece
histórica y no se vuelve a ejecutar. Revalida perfil, Owner/version de membresía,
grant/version/fecha, clave VERIFIED/habilitada/revisión y precio/modelo fijados.

El puerto conserva los locks hasta el COMMIT de la fase RECONCILE del motor. El
runtime dedicado admite una autoridad adicional fijada por el vendedor opaco,
siempre compuesta con su autoridad de control existente; no cambia el kernel
general ni acepta un callback de acción/HTTP. El reloj nativo del permiso se
comprueba después de la última verificación del motor y antes de su COMMIT.
La ventana histórica de 60 segundos del POST no se renueva ni se reutiliza: el
resultado ya está liquidado y sólo se consulta, sujeto a los permisos actuales.
No se reserva, cobra, descifra una clave ni realiza otro INTENT/POST.

La revocación previa mantiene AWAITING_EFFECT/AI_AUTHORITY_UNAVAILABLE con la
propuesta y costo intactos. Una revocación concurrente espera los locks de esa
fase corta; nunca se mantiene esta transacción durante materiales o proveedor.

La composición necesita dos conexiones simultáneas del pool de control, además
de la conexión del motor. El driver limita cada adquisición de control a dos
segundos; si el pool tiene capacidad uno o está agotado, rechaza y libera los
locks exteriores. Una adquisición que llega tarde se devuelve sin ejecutar SQL.
No se mantiene una espera indefinida ni se convierte el timeout en permiso.

El primer consumo de una respuesta SUCCEEDED exige exactamente la misma autoridad
viva que una propuesta guardada. El vendedor opaco distingue el `ai_run` RUNNING
recién liquidado del AWAITING_EFFECT histórico; ambos pasan por el intento nativo
SUCCEEDED y sus locks antes de RECONCILE. Si el proveedor respondió después de una
revocación, se conservan propuesta, recibo y costo en AWAITING_EFFECT sin crear
un efecto. No se pierde el resultado ni se repite la llamada. Esta condición no
se sustituye por haber autorizado el POST previamente.
