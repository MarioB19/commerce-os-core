# Calentamiento automático `standard-15d/v2` · decisión 20 septiembre 2026

## Decisión

Las nuevas altas y los nuevos programas estándar usan `standard-15d/v2`. El recorrido acredita catorce días automáticos, uno por fecha local con evidencia producida por el pipeline, y evalúa desde el día nominal 15. V2 no tiene días manuales, `manualReady` ni checklist. `standard-15d/v1`, `legacy-30d/v1` e `inbound-light/v1` permanecen disponibles para leer y ejecutar historia existente; nunca se reinterpretan silenciosamente como v2.

## Curva y evaluación

La cuota por cuenta conserva una progresión deliberadamente conservadora: 5–15 mensajes y 1–3 conversaciones en los días 1–7; 20–40 y 3–6 en los días 8–10; 60–120 y 6–12 en los días 11–14. Un día incompleto no aumenta el siguiente presupuesto ni se recupera acumulando volumen. Fin de semana aplica el factor existente.

La evaluación del día 15 exige catorce créditos, estabilidad observada durante siete días, al menos veinte efectos maduros, entrega mínima de 98 % y ausencia de restricción confirmada. La graduación de preparación no autoriza ventas, mantenimiento ni actividad REAL.

## Evidencia y migración

`warmup_day_credits` registra hechos inmutables por episodio y fecha. Un crédito v2 sólo nace de un plan automático `COMPLETED`; `source_plan_id` es único para impedir reutilizarlo en otro episodio. El estado acumulado sigue siendo una proyección, no la autoridad de evidencia.

La migración es individual, explícita y revisada. El preview selecciona hasta catorce planes compatibles del perfil anterior, en fechas distintas, dentro del episodio y no usados antes. Aplicar requiere el pool pausado y ausencia de efectos `SENDING` o `UNKNOWN`; cierra el episodio anterior, crea uno v2 enlazado y conserva sólo esa evidencia automática. Declaraciones, antigüedad y checklists no crean créditos. Un episodio completado se preserva.

## Ejecución y límites

Activar un programa v2 crea los episodios faltantes de sus participantes y sella la versión en el alcance autorizado. Los planners y dispatchers directos y de grupo validan episodio, versión, preparación, membresía, contenido y autorización antes de generar o enviar. Los guards comerciales siguen exigiendo graduación y controles del producto concreto.

API, MCP y web muestran 0 + 14, evaluación día 15, siguiente ejecución y fecha estimada. La UI sólo presenta el checklist cuando lee un episodio v1 histórico. SIMULATION demuestra software y calendario; no acredita reputación, actividad física ni autorización REAL.

## Compatibilidad y rollback

La migración SQL es aditiva (`0059_warmup_policy_v2.sql`): añade el vínculo de episodio a planes y el ledger de créditos sin modificar filas v1. Un rollback operativo pausa programas v2 y conserva episodios, planes, créditos, auditoría y resultados inciertos. No se elimina el esquema ni se convierten episodios v2 de vuelta a v1.

## Estado de entrega

El código, la migración 0059 y los recorridos API/MCP/web/workers están implementados y pasaron la validación local completa, incluida la secuencia SIMULATION 1→4→5→14→15, activación idempotente, pausa/reanudación sin ráfaga y revocación conservadora. El release `ci-35525885616-1-3de8b13fd345` quedó instalado con 59 migraciones, incluido el hash exacto de 0059; HTTPS y OpenAPI confirmaron el runtime nuevo. La activación REAL permanece en `false`: no se modificaron programas, assignments ni autorizaciones, y siguen pendientes QR/2FA cuando aplique, cuentas conectadas, vigencia física de autorización, recepción y catorce días reales. [Recibo](evidence/sales-flow-warmup-v2-publication.json).
