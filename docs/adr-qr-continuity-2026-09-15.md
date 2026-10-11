# Continuidad de sesiones QR — decisión 15-sep-2026

Autorización: implementar F0–F5 y pruebas/publicación de F6 en el CI/CD vigente. Base inspeccionada: `0a5e907`. Se conserva infraestructura, sesiones, pausas, permisos y trabajo concurrente. Piloto físico y 21 días se registran aparte.

## Decisiones antes de implementar

- `channel_sessions` amplía la cuenta comercial; `session_ownership` continúa como única autoridad de lease/generación. La identidad esperada permanece tras logout y cambios técnicos. Las cuentas nuevas conservan uso del principal desconocido y recuperación desactivada.
- Lecturas de salud de todas las cuentas por antigüedad, con concurrencia acotada. Una lectura no transfiere ownership. Observaciones tardías no reemplazan evidencia nueva. WORKING requiere identidad coincidente para acreditar conexión.
- El supervisor encola comandos existentes sólo con consentimiento explícito de recuperación, estado deseado RUNNING, principal mantenible y pausas liberadas. Revalida bajo lock antes del efecto remoto. Recupera ownership únicamente con las pruebas de aislamiento vigentes. No emite autorización comercial.
- Reintenta únicamente una caída confirmada a STOPPED después de conexión verificada, sin repetir respuestas remotas inciertas. FAILED genérico/timeout/autenticación/passkey/identidad distinta exigen diagnóstico. Cinco intentos persistentes (5/15/45/120/300 s con jitter); presupuesto se restablece tras 30 minutos estables observados. Una mutación incierta bloquea nuevas mutaciones hasta conciliación explícita.
- Uso del principal: declaración humana auditada, fuente explícita y fecha real, nunca inferida de WAHA. Recordatorios 10/12/13/14 días, deduplicados por cuenta y episodio en `operational_alerts`. No se configura ningún destinatario nuevo.
- Respaldo WAHA separado de COMOSB02: paquete cifrado autenticado, manifiesto y hashes, captura fría por gateway previamente detenido y aislado; herramienta no detiene ni arranca gateways. Restauración a directorio nuevo sin red y validación antes de montaje. La captura activa no se considera consistente. Programación diaria registra necesidad de copia; una ventana de interrupción autorizada es requisito para capturar un gateway activo.
- Recuperación de corrupción: solicitud auditada y pausada por API; procedimiento administrativo con cuarentena cifrada, volumen nuevo y recibo verificable. API no acepta rutas arbitrarias ni ejecuta Docker. Revincular conserva historia e identidad; QR efímero y reanudación separados.
- UI: detalle de número organizado por conexión/principal/recuperación/configuración, acciones primarias claras y formularios con etiquetas, errores y foco. Los mismos contratos soportan API/MCP.

## Fuentes y límites

[WAHA Sessions](https://waha.devlike.pro/docs/how-to/sessions/) y [Storages](https://waha.devlike.pro/docs/how-to/storages/) consultados el 15-sep. La versión desplegada sigue fijada por digest; no se actualiza WAHA. El umbral de 14 días es preventivo según el plan; no demuestra revocación. El centro de ayuda de WhatsApp no entregó texto en esta consulta. No se afirma validación física ni consistencia de una copia activa.

## Cierre de decisiones

- Las URLs WAHA entran por el catálogo canónico de topología existente. El índice SQL reserva el gateway físico entre espacios REAL; referencias aún sin configurar no acreditan una reserva física. La API rechaza alias arbitrarios de URL.
- Configuración y efecto remoto se serializan por cuenta; el lock se mantiene durante la llamada con timeout del proveedor. Una caída del proceso deja el comando pendiente/UNKNOWN para conciliación. Lecturas antiguas no reemplazan evidencia nueva.
- Restaurar COMOSB02 desactiva recuperación y expira salud aunque la copia tuviera RUNNING. Logout confirmado incrementa la generación; copias anteriores quedan identificadas como tales.
- El método de respaldo entregado está validado para GOWS y conserva permisos/uid/gid sin cambiarlos en origen. El cifrado del disco de infraestructura, copia fuera del host y autenticación posterior requieren evidencia administrativa/física independiente; no se modifica el volumen productivo para conseguirla.

- La regresión del worker descubrió que `recoverSending` comparaba un claim de warm-up virtual con reloj de pared. Se corrige sólo SIMULATION para usar el mismo reloj del run que el dispatch; el tratamiento de efectos REAL inciertos se conserva. Prueba de proceso y caso de expiración virtual incluidos.
- La primera revisión de respaldo se solicita a la misma unidad systemd que usa el temporizador persistente. Así se espera una ejecución ya iniciada por una fecha vencida y no compiten dos procesos por el lock administrativo.

- CI detectó una carrera en la prueba de campañas: Radix oculta el diálogo padre del árbol accesible mientras el formulario hijo está abierto. Esperar un único diálogo no prueba que el hijo cerró; la prueba ahora espera el título exacto del formulario y cierra el título exacto del pedido. Se conserva la expectativa de cero diálogos al terminar.
- Una señal fechada antes del último lifecycle confirmado no puede sobrescribirlo. Después de credenciales nuevas, observar WORKING con la identidad esperada cambia la etapa a identidad verificada pendiente de revisión; no cambia pausa, recuperación automática ni permisos de envío. Esto evita dejar la UI esperando QR después de una conexión verificada y no equivale a validar autenticación por restaurar archivos.
