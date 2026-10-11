# ADR — Motor creativo 1.1 y voz WhatsApp independiente

Fecha: 2026-09-12. Estado: aceptado para implementación local; producción y efectos externos requieren sus autorizaciones existentes.

## Decisión

Conservar recetas 1.0.0 y helpers extraídos; añadir receta 1.1.0 con presentación cerrada y política Vibe `infoproduct-attraction-led-v2-packshot`. La fuente actual `meta-direct-response-v1.json`, el estándar visual y el plan rector v1.2 coinciden: atracción dinámica mínima 60%, demostración UI como máximo un bloque de 5 s, packshot único de 2 s fuera del hook y combinado UI+packshot máximo 8 s/20%. La mención90%/6s de una matriz secundaria no sustituye estas fuentes.

Cada escena requiere revisión visual ligada al SHA y hash de dirección/duración/recorte; la licencia se confirma separadamente por la biblioteca. Los overlays de hook, beneficios, oferta y CTA usan texto visible aprobado con fuente, localizador, SHA y hash exacto del texto. El cambio de fuente invalida sus aprobaciones y huellas dependientes. Música, packshot, overlays y política participan en la huella de render; cambios de copy Meta siguen reutilizando el raster.

La composición verifica el DOM con la tipografía cargada en cada frame: overlays dentro de x65/y270/w950/h980; subtítulos con excepción exclusiva al borde inferior1536 y2–4 palabras. La QA1.1 mide negro>=.25s, silencio>=1.2s, LUFS[-17,-13], truepeak<=-1dB y sincronía con referencia. Mantiene separados conformidad de inputs, QA técnica, revisión editorial y aprobación de producción.

Voz WhatsApp es un brief versionado independiente del anuncio; acepta texto completo hasta10000 caracteres y máximo180s, conserva voice_settings en request/hash/recibo y usa las mismas reservas, idempotencia, UNKNOWN y recuperación de audio ya pagado. No dividir, acelerar ni regenerar automáticamente. Recetas y operaciones legadas sin purpose conservan límites1200/60.

## Verificación y límites

Pruebas de contratos, invalidación, composición en navegador y QA sobre medios sintéticos; integración PG aislada con proveedor simulado para voz. No se genera el master de lanzamiento ni se factura proveedor. La publicación del Worker firmado y su prueba física permanecen pasos operativos del lanzamiento.
