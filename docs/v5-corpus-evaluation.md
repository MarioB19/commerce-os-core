# Evaluación fija sintética de Inteligencia

El corpus `commerce-synthetic-intelligence-12-v1` contiene doce casos: texto completo, parcial, precios contradictorios, fuente duplicada, todas las fuentes caídas, caída parcial, texto sin procedencia, enlace de video sin texto, métricas no acreditadas, condiciones de precio diferentes, instrucciones incrustadas y contradicción de entregables con otra fuente caída. Las fuentes usan `example.invalid`, no clientes ni observaciones de mercado.

Hash del corpus: `d4e33788f3f3b9a993f43807e30881289ac6533d16af54c2bac819ab6df2110c`. Hash independiente del oráculo: `9dca3697eb858aaec9151e920683ada39c25408b47b3d4cdc749aeb4269c4cfe`. El oráculo no se envía al proveedor. El baseline conserva literalmente el prompt V4 de `packages/intelligence/src/index.ts` en `07479cadf94f3049a1a98229d02f307235d06b73`; ambos brazos reciben el mismo adaptador de salida compacta y el mismo input. Por tanto, se comparan prompts bajo ese adaptador, no dos pipelines históricos completos.

Cada caso aporta ocho comprobaciones: cobertura, dimensiones explícitas, citas trazables, contradicción, duplicados, faltantes, ausencia de métricas inventadas y modalidad sólo texto. La utilidad estructural es la fracción de 96 comprobaciones satisfechas. Identidades duplicadas, métricas inventadas o JSON inválido producen `INVALID_OUTPUT`, no una puntuación aparente. La evaluación no acredita utilidad comercial, exactitud general, análisis audiovisual ni revisión humana.

## Contrato operativo

Consultar `GET /v1/intelligence/corpus-evaluation-fixture?environment=REAL` devuelve versión/hash, casos, oráculo y estimaciones sin llamar al proveedor. Para una ejecución autorizada, enviar `POST /v1/intelligence/corpus-evaluations?environment=REAL` con `Idempotency-Key` estable y:

```json
{
  "corpus_version": "commerce-synthetic-intelligence-12-v1",
  "corpus_hash": "d4e33788f3f3b9a993f43807e30881289ac6533d16af54c2bac819ab6df2110c",
  "expected_version": 1,
  "max_cost_usd": 0.04,
  "confirmation": "EVALUATE_FIXED_SYNTHETIC_CORPUS"
}
```

`expected_version` debe ser la revisión vigente del perfil OpenAI, no asumir el ejemplo. Se requiere `intelligence:analyze`, recurso `intelligence:openai`, membresía activa y presupuesto global explícito vigente además del presupuesto del proveedor. Se aplican los topes vigentes menores; la estimación de ambos requests debe caber antes de crear la evaluación. El broker vuelve a verificar límites y revisión antes de cada request. Si otro consumo ocupa la capacidad entre ambos, el resultado queda parcial, sin aumentar límites. SIMULATION rechaza la llamada externa.

Se usa `gpt-5.4-mini-2026-03-17`, máximo 3000 tokens de salida por brazo. La tarifa estándar pública consultada el 2026-09-13 es USD0.75 por millón de entrada, USD0.075 de entrada cacheada y USD4.50 de salida. La estimación conservadora actual es USD0.019183 + USD0.019311 = USD0.038494; no es una factura ni costo real. Se deriva de bytes conservadores más el máximo de salida. [Tarifa y snapshot oficiales](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

La respuesta y lecturas posteriores (`GET` colección y `/:id`) incluyen estado durable, ambos resultados, operaciones del broker, costo confirmado por uso reconocido, reserva pendiente y latencia local por request. Un resultado `UNKNOWN` detiene el segundo brazo y conserva la reserva. Repetir la misma clave sólo lee el resultado; otra clave con el mismo corpus y revisión se rechaza con el ID existente. Cambiar la revisión del perfil constituye otra evaluación, sujeta a autorización y presupuesto propios.

`POST /v1/intelligence/corpus-evaluations/:id/reconcile` con `{"confirmation":"READ_EXISTING_PROVIDER_OPERATIONS_ONLY"}` consulta operaciones que ya existen. No emite solicitudes al proveedor ni inicia un brazo faltante. La ejecución y reconciliación comparten un bloqueo de sesión; no pueden pisarse aunque un request demore. Recuperar una respuesta OpenAI perdida, cuando existe ID recuperable, usa por separado el mecanismo de lectura del broker; después esta reconciliación proyecta el resultado. No repetir inferencia para resolver incertidumbre.

## Evidencia local

Tres pruebas unitarias y seis integraciones en PostgreSQL aislado verifican corpus/oráculo, dos requests con idéntico input, costo y latencia persistidos, permisos, ambiente, presupuesto, idempotencia, carrera con reconciliación, output incompleto y reserva UNKNOWN. El transporte de estas pruebas es una fixture explícita, con respuestas preparadas a partir del oráculo; su puntuación perfecta sólo valida el evaluador. No se han realizado llamadas reales, revisión humana ni medición de mejora V4→V5 en esta etapa. No se insertan oportunidades, productos ni observaciones de mercado.
