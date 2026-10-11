# Piloto V1 · límites previos al consumo

Autorización: solicitud de Brandon del08-sep-2026, SHA en evidence/creative-v1/h0.json. Decisión autónoma: usar créditos accesibles primero. No se asume saldo a partir de una API key ni suscripción del asistente.

**Coste vigente al 08-sep:** Remotion gratuito, USD 0 y sin renovación. Se contrató Workers Paid por USD 5/mes (siguiente periodo 08-oct) y se amplió el disco por aproximadamente USD 0.40/mes antes de impuestos. OpenAI contabilizó USD 0.086581 por veinte análisis. SearchAPI conserva USD 0.028 reservados por siete operaciones y ElevenLabs USD 0.4023 por dos voces; esos importes estimados no son cargos monetarios confirmados. R2 factura el consumo aplicable; el piloto conserva sus límites. No hubo nueva suscripción a SearchAPI o ElevenLabs ni recarga de OpenAI por esta ejecución.

| Servicio | Piloto máximo | Reserva / compra mínima permitida | Renovación |
|---|---|---|---|
| SearchAPI | 8 llamadas (2nichos×BR/MX×2páginas), 100anuncios por ejecución | Coste teórico USD0.032; primero100créditos iniciales si cuenta elegible. Sólo si necesario Developer USD40mes | Mensual si se contrata; seguimiento apagado |
| OpenAI gpt-5.4-mini-2026-03-17 | 20análisis, por llamada ≤60000bytes input+3000output tokens | Presupuesto USD2; saldo existente comprobado | Consumo; recarga automática preexistente sin cambios, detalle abajo |
| ElevenLabs | 2voces máximo60s y1200caracteres cada una, voz propia autorizada | Reserva USD0.72 a0.30/1000caracteres como estimación conservadora; primero cuota existente. Starter hastaUSD5 si necesario | Mensual sólo si nueva contratación |
| R2 Standard + verificador | 2GiB durables,4GiB staging/final,2000operacionesA,10000B,100verificaciones | HastaUSD5 de operación piloto; franquicia sólo si disponible. Workers Paid USD5 si free no permite verificación | Mensual/consumo según alta |
| Remotion 4.0.503 | 4renders nativos iniciales y2del circuito API/worker; hasta2trabajos adicionales para verificar cache entre versiones (uno siembra y otro debe reutilizar raster), sin proveedores nuevos | **USD0. FREE_ELIGIBLE: Brandon confirmó que son2personas.** Sin compra de renders ni suscripción; la reserva retirada no se reasigna | Sin renovación. Revisar elegibilidad si el equipo pasa a4+personas |

Límite agregado vigente del piloto: **USD60**, incluyendo impuestos/cargos obligatorios. El límite histórico inicial era USD160; se retiró la reserva de USD100 de Remotion tras la indicación de Brandon, sin reasignarla a otros servicios. Los límites individuales se conservan y el disco añade aproximadamente USD0.40/mes. Las altas confirmadas se registran abajo. Si el mínimo aplicable excede el límite se conserva únicamente ese requisito externo pendiente. Nada de gasto Ads. Límites de aplicación no garantizan un corte absoluto de facturación de cuenta.

Precios consultados08-sep: [SearchAPI](https://www.searchapi.io/pricing), [OpenAI](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [R2](https://developers.cloudflare.com/r2/pricing/), [Remotion](https://www.remotion.dev/). La voz es reserva estimada pendiente de cuota/precio efectivo de cuenta, no recibo confirmado. Los campos estimated y confirmed permanecen separados.

## Consumos / altas verificadas

- Primer render local239s, evaluación interna,0llamadas proveedor. MASTER/preview/captions/copy/manifest nuevos; no consumoTTS.

- SearchAPI al configurar:100consultas iniciales, sin plan activo; key privada configurada. El consumo posterior queda registrado al final.
- OpenAI cuentaAPI accesible conUSD7.73 de saldo (15:13UTC). Autoreload ya existía antes: umbralUSD5→saldo10, máximoUSD10/mes. No se creó ni modificó; el presupuesto pilotoUSD2 está por debajo de la diferencia de saldoobservada al umbral, sin garantía sobre consumos simultáneos de otros proyectos.
- Segundo renderMac323.44s,0llamadas proveedor. Dos renders de evaluación completados; no contrataciónRemotionCompany.

- 15:28UTC: R2 activado con medio de pago legítimo guardado; checkout confirmó Purchase complete/subscription active, baseUSD0mes. Franquicia10GB/1MA/10MB mensual; exceso0.015USDGBmes/4.50USDmillónA/0.36USDmillónB. Piloto siguelimitado2GiB y cuotaoperaciones indicada. No se registró número de tarjeta ni dirección.
- ElevenLabs GETsubscriptionreal: Creator activo,9253/215108caracteres consumidos,205855disponibles,extensiónautomática no disponible; sincompra necesaria. [Licencia de planes pagados](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform), condicionado a derechos sobreinputs y noBeta.
- OpenAI proyecto Commerce OS Intelligence V1 creado, key restringida únicamenteResponses, secreto0600; sin llamadas al momento del alta.
- Workers Paid activado el08-sep-2026: checkout confirmó Purchase complete y USD5 cobrados hoy, renovación mensual (siguiente periodo08-oct). Requerido porque el verificador con CPU30s fue rechazado por el plan Free (100328). No se contrataron complementos.
- Bucket privado Standard `commerce-os-creative-v1` creado. Credencial de objetos Read/Write limitada a ese bucket, vigencia6meses (rotar antes08-mar-2027). Claves y token del verificador guardados únicamente en archivos privados0600.

- Antes de conocer el tamaño del equipo se consideró Remotion Automators por USD100/mes y se preparó su checkout; no se completó la compra. Esa opción quedó descartada por la indicación posterior de Brandon y la elegibilidad gratuita confirmada.

- Actualización de Brandon durante la ejecución: solicita evitar Remotion Pro y operar con la licencia gratuita. Se cerró el checkout sin suscripción ni cobro de Remotion. La licencia4.0.503 permite individuos y organizaciones lucrativas≤3empleados; la FAQ vigente describe equipos≤3personas y aclara que pueden automatizar sin comprar renders. Mismas funciones gratuitas/pagadas. [Licencia4.0.503](https://github.com/remotion-dev/remotion/blob/v4.0.503/LICENSE.md) · [FAQoficial](https://www.remotion.dev/docs/license/faq).

- Brandon confirmó expresamente que el equipo son2personas. Se registra FREE_ELIGIBLE paraRemotion4.0.503, incluyendo uso comercial y automatización, sin suscripción, cuenta de pago ni compra de renders. CosteRemotionUSD0 y sin renovación. Reevaluar sólo si la organización/equipo pasa a4+personas o cambia la elegibilidad. Los renders históricos siguen acreditados como evaluación al momento de ejecutarse; las operaciones siguientes podrán usar Free.

- 08-sep, 17:19 UTC: disco existente del VPS ampliado de 30 a 40 GiB, conservando `pd-standard`, datos y servicios. Coste incremental estimado **USD 0.40/mes** (10 GiB × USD 0.000054795/GiB-h × 730 h), prorrateado, antes de impuestos; capacidad total aproximada USD 1.60/mes. No se borraron imágenes, releases ni respaldos. `growpart` y `resize2fs` ampliaron ext4 en línea: 14,254,063,616 bytes libres, siete contenedores con la misma hora de arranque, cero reinicios/OOM, dos GET comerciales HTTP 200. [Precio oficial](https://cloud.google.com/compute/disks-image-pricing) · [Procedimiento oficial](https://docs.cloud.google.com/compute/docs/disks/resize-persistent-disk) · evidencia `docs/evidence/creative-v1/vps-disk-expansion.json`.

- 08-sep, 18:58 UTC: ElevenLabs completó exactamente dos POST autorizados,1341caracteres de texto y738unidades de uso observadas en los receipts. Audios nuevos51.017s y43.363s, con alignment y SHA verificados en R2. El proveedor no confirmó un importe monetario: **USD confirmado desconocido**; la reserva conservadoraUSD0.4023 permanece retenida dentro del límiteUSD0.72. `spent_usd=0` del presupuesto no significa que las llamadas fueran gratuitas. No hubo nueva suscripción, recarga ni repetición de POST. [Evidencia](evidence/creative-v1/elevenlabs-published-765e7709.json).

- 08-sep, 19:33 UTC: cuatro búsquedas BR/MX completadas con siete operaciones SearchAPI y146observaciones, cobertura PARTIAL. SearchAPI registró siete unidades yUSD0.028 reservados, sin coste confirmado. Veinte análisis OpenAI de texto COMPLETED:40,770unidades yUSD0.086581 contabilizados por el broker. Seguimiento automático apagado, sin errores UNKNOWN ni repeticiones ciegas; se conservaron los límites de ocho búsquedas de proveedor y veinte análisis. [Evidencia](evidence/creative-v1/intelligence-pilot.json).
