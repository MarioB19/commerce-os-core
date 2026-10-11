# Latencia comercial HTTPS · PERF-01

El ejecutor `scripts/creative-commercial-latency.mjs` mide lecturas de producción desde el cliente, con la sesión legítima de `~/.config/commerce-os-production/login.env`. No exporta datos, sincroniza Meta, llama proveedores ni modifica objetos comerciales. El único POST es el inicio de sesión. No guarda cuerpos de respuestas, cookies, email, contraseñas ni identificadores de clientes.

## Muestra y umbral

- 40 GET medidos por fase: 20 a `/v1/reports/summary` (ventas por comprobante) y 20 a `/v1/reports/campaign-performance`.
- Dos warmups excluidos y un login: máximo43 requests por fase con configuración predeterminada.
- Concurrencia máxima2 y separación500ms entre inicios. No invalida cachés ni realiza cálculos/render en el VPS.
- Ventana comercial y parámetros fijados en `docs/evidence/creative-v1/commercial-latency-plan.json`; las tres fases reutilizan el mismo plan y hash.
- p50/p95 del tiempo HTTPS completo y TTFB, códigos HTTP, errores y tamaños en bytes. Percentil por rango más cercano; cada endpoint se compara por separado.
- PERF-01 pasa si el aumento de p95 es ≤ el mayor entre20% del baseline o100ms, sin errores en la muestra. Un fallo de autenticación, endpoint o red nunca se convierte en PASS.

Los tiempos incluyen cliente/red/proxy/API/DB/transferencia. CPU, RAM, disco, OOM y actividad real de uno o dos equipos requieren evidencia separada. `--render-context` y `--deployment-sha` son referencias declaradas por el operador; el ejecutor no las infiere del tiempo de respuesta.

## Estado del intento del 08-sep-2026

El acceso original fue rechazado con HTTP401 `INVALID_EMAIL_OR_PASSWORD`: hubo un intento inicial y uno diagnóstico explícito. `/livez` y `/readyz` devolvieron200; el formato del archivo, permiso0600, origen y estructura de login coinciden con los scripts existentes. El endpoint también utiliza ese401 cuando una cuenta no tiene membresía activa; no demuestra por sí solo cuál de esas condiciones se cumple. No se cambiaron contraseñas de personas.

Se recuperó el acceso mediante el aprovisionamiento autorizado de una cuenta técnica temporal `viewer`, documentado en `docs/intelligence-technical-pilot-accounts.md`. Su inicio de sesión HTTPS y la línea base quedaron verificados: **40/40 HTTP200, p50 84.749ms, p95 161.515ms**, concurrencia máxima2. Evidencia: `docs/evidence/creative-v1/commercial-latency-before.json`. La fase during también pasó:40/40 HTTP200 y p95 90.623ms sobre `5e4747f373ce0a9eb8925c73c3153f863550c92f`. Las lecturas API antes/después del benchmark19:37:47–19:38:08UTC confirmaron ambos renders RUNNING, progreso creciente, los mismos intentos y fence1, con leases renovados. Evidencia: `commercial-latency-during.json` y `commercial-latency-during-context.json`. La fase after pasó con ambos Workers detenidos:40/40 HTTP200 y p95 88.738ms. Los snapshots API19:46:37–19:46:58UTC confirmaron ambos jobs REVIEW, render COMPLETED100% y ningún intento RUNNING. El cierre19:48:07 confirmó current5e y los mismos contenedores API/automation/web, antes de iniciar el instalador siguiente. Evidencias: `commercial-latency-after.json`, `commercial-latency-after-context.json` y `vps-resources-after.json`.

Tres muestras VPS19:38:21–19:38:33UTC, también dentro de la concurrencia real y con snapshots API que delimitan ese intervalo, registraron CPU del host7.143–12.626%, memoria disponible≥6.041GB, siete contenedores activos, cero reinicios/OOM y cero procesos de render detectados. Ese intervalo es posterior al benchmark HTTP; no se presentan como muestras tomadas al mismo segundo. Evidencia: `vps-resources-during.json`.

El despliegue de esta línea base es `fdca43ca3f1d41f0f560b985c260a2bc58cb21b7`: [run34233366458](https://github.com/MarioB19/commerce-os/actions/runs/34233366458), jobdeploy success, artefacto `deployment-34233366458-1` con SUCCEEDED y fin14:01:39UTC; el enlace current del VPS confirmó la misma release. La evidencia inicial del rechazo se conserva en `docs/evidence/creative-v1/commercial-latency-before-attempt.json` como antecedente.

## Ejecución manual coordinada

Después de resolver el acceso legítimo y confirmar el SHA aplicable:

```sh
node scripts/creative-commercial-latency.mjs --phase before --deployment-sha SHA_VERIFICADO --login-env /Users/example-user/.config/commerce-os-creative/technical-pilot-v1/login-administrator.env
```

Sólo ante la señal del integrador y con los renders observados en marcha:

```sh
node scripts/creative-commercial-latency.mjs --phase during --deployment-sha SHA_VERIFICADO --render-context TWO_DEVICES --login-env /Users/example-user/.config/commerce-os-creative/technical-pilot-v1/login-administrator.env
```

Después de terminar esa actividad:

```sh
node scripts/creative-commercial-latency.mjs --phase after --deployment-sha SHA_VERIFICADO --render-context IDLE --login-env /Users/example-user/.config/commerce-os-creative/technical-pilot-v1/login-administrator.env
```

No se instala automatización ni se inicia producción desde este script. Los informes usan `commercial-latency-before.json`, `commercial-latency-during.json` y `commercial-latency-after.json`. No se sobrescribe una fase existente. Si cambia origen o muestra, se exige un nuevo experimento con `--output-dir` propio. Se puede reintentar el before que sólo creó el plan y falló al autenticar, conservando el plan.

Seis pruebas sin red pasan con `node --test scripts/tests/creative-commercial-latency.test.mjs`: límites/rutas, percentiles/errores, umbral, descarte de payload, concurrencia2 y aborto tras warmups fallidos. Son pruebas del ejecutor, no mediciones de producción.
