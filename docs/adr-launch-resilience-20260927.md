# Recuperación y preparación de lanzamiento — 27-sep-2026

Estado: decisión de implementación; publicación y lectura productiva pendientes.

La auditoría del 27-sep reprodujo leases vencidos que no se recuperan con reconexión deshabilitada y un segundo gate que termina el flujo sin llamada externa. La petición actual autoriza corregir estos defectos y el resto del diagnóstico; el número terminado en 7343 se conectará después y queda fuera del piloto. No activar pauta, enviar mensajes, inventar revisiones humanas ni cambiar permisos comerciales.

## Decisiones

1. Separar mantenimiento de la propiedad del worker y reconexión del transporte. Sólo recuperar al propietario/generación actuales bajo exclusión de DB; nunca transferir a un dueño distinto por simple vencimiento. Mantener congelamientos explícitos y la exigencia de aislamiento de dueños anteriores.
2. Conservar mensajes ante bloqueos transitorios previos a HTTP. Liberar de manera atómica reservas e intentos no externos, preservar la cadena causal y revalidar antes del siguiente intento. No repetir efectos que sí llegaron al proveedor con resultado UNKNOWN.
3. Readiness comprueba progreso de los loops críticos, además de DB. Expresar salud/ownership vencidos en resúmenes y señales para alertas existentes; evitar respuestas verdes a un despachador detenido.
4. Acotar lecturas de salud mediante consultas agregadas e índices aditivos adecuados, con comparaciones de resultado y latencia. No eliminar historia ni alterar migraciones existentes. Evitar consultas de capacidad duplicadas.
5. Resolver vendedor/oferta y proveedor heredado con la misma semántica de la asignación efectiva; diagnóstico ambiguo debe pedir contexto explícito, no emitir un conflicto falso.
6. Preparar un paquete revisable de configuración para 8571/8970 con oferta vigente, 7343 diferido y anuncios PAUSED. Mantener snapshots históricos, aprobación comercial ligada a revisión y separación de publicación interna, permisos y campaña.
7. El ensayo del catálogo publicado encontró que el simulador genérico acepta efectos pero no emite ACK, por lo que un flujo que exige entrega queda esperando correctamente. Añadir un adaptador cerrado sólo para laboratorios SIMULATION con proveedor simulator, cuenta marcada y efecto/conversación/simulación coincidentes en DB. Un ACCEPTED genera un sobre ACK explícitamente simulado y deduplicado que atraviesa los consumidores normales; UNKNOWN o rechazo no generan ACK. Correlacionar por provider_message_id, sin un hint que pueda confirmar un efecto todavía SENDING. Nunca modificar evidencia REAL ni equiparar esta entrega sintética a recepción física. Conservar el ensayo productivo anterior como parcial; la nueva conducta requiere pruebas locales y publicación posterior.

## Aceptación

Regresiones reproducen los fallos originales y prueban recuperación exactamente una vez; invariantes de fencing/UNKNOWN/pausa siguen pasando. Medir las rutas de diagnóstico con datos representativos. Ejecutar tipos, lint, build, suites necesarias, prueba de recuperación y revisión independiente. Sólo una instalación verificada del SHA probado acredita la corrección productiva. Alertas externas, respaldo WhatsApp autenticado, aprobación editorial y piloto físico requieren evidencia propia; no se sustituyen por simulación.
