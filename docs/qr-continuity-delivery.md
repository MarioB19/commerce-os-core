# Entrega de continuidad WhatsApp QR

## Publicación verificada

**Publicado el 15-sep-2026 a las 13:24:46 México / 19:24:46 UTC.** SHA `2c6359928c5346e0e4c4999024ae0e2b5849f989`, release `ci-35010141566-1-2c6359928c53`, [CI/CD 35010141566](https://github.com/MarioB19/commerce-os/actions/runs/35010141566) SUCCESS y deploy SUCCEEDED. Manifiesto y archivo privado verificados contra el SHA y los hashes publicados por CI; [recibo del servidor](evidence/qr-continuity/publication.json).

- **46 migraciones y seis servicios sanos**, imágenes y archivos web coincidentes con el paquete, HTTPS y cabeceras comprobados. REAL sigue congelado.
- **Gateway y volumen conservados:** GOWS, mismo contenedor, imagen, configuración, montaje `commerce-os_waha-01-sessions` y arranque del 06-sep; `restart: no` y autostart deshabilitado. Directorio observado root:root/0755; cifrado del disco no observado.
- **Cuenta conservada:** envíos false, deseo STOPPED, pausa true y recuperación false. Conexión/autenticación/principal UNKNOWN; no se atribuye el FAILED anterior a revocación. Cinco lecturas API 200 y contrato OpenAPI verificados; cuatro lecturas web 200. [API](evidence/qr-continuity/production-after.json) · [web](evidence/qr-continuity/public-web.json) · [configuración antes/después](evidence/qr-continuity/integrations-after.json).
- **MCP:** 66 herramientas, incluidas las seis de continuidad; consulta real STDIO→HTTPS aprobada, paquete firmado instalado con la credencial y permisos anteriores. [Consulta](evidence/qr-continuity/mcp-production.json) · [instalación](evidence/qr-continuity/mcp-installation.json). Los procesos existentes siguen intactos; recargar la conexión MCP en Codex para cargar el paquete nuevo. Escrituras requieren `channels:manage`; no se amplió el token.

CI final: **361 unitarias + una omisión nativa, 444 integraciones + una QR física opcional, 107 E2E, 103 Python y 23 scripts Node**, tipos/lint/build, recuperación y auditoría aprobados. Incluye 20 cuentas sintéticas con máximo cuatro lecturas simultáneas. [Resultados](evidence/qr-continuity/ci-validation.json). La revisión inicial falló en un selector de diálogo y no desplegó; la final aprobó la suite completa.

## Estado real del respaldo

El temporizador diario quedó habilitado. Su primera ejecución a las **19:24:38 UTC** registró `AWAITING_AUTHORIZED_COLD_WINDOW`: el gateway estaba activo, por lo que **no existe una copia fría nueva verificada de sus credenciales en esta entrega**. En la cuenta, backup permanece UNKNOWN y se genera la alerta correspondiente. El procedimiento cifrado y la restauración aislada fueron probados con archivos sintéticos, sin acreditar autenticación real.

Paso pendiente concreto: acordar una ventana para una cuenta controlada y su custodio; detener/aislar sólo bajo esa autorización, ejecutar la copia consistente, verificarla, conservar una copia fuera del host y ensayar restauración sin red antes de probar identidad. El volumen original se conserva. Cifrado del disco, custodia externa y aceptación de autenticación siguen sin evidencia.

## Cobertura del plan

| Fase | Software entregado | Evidencia operativa pendiente |
|---|---|---|
| F0 | Inventario por cuenta; principal, responsable, aplicación, disponibilidad y custodia; lectura del runtime sin revelar credenciales. | Registrar responsables y principales reales. Permisos del directorio y volúmenes verificados en el deploy; cifrado del disco necesita confirmación administrativa. |
| F1 | Sesión, estados, identidad esperada, generaciones, historial, revisiones y declaración humana del principal; web/API/MCP. | Uso físico del principal y confirmación por su responsable. |
| F2 | Archivo WAHA cifrado específico, manifiesto, hashes/permisos, temporizador diario y restauración aislada; conservación de volúmenes. | Ventana de copia consistente si el gateway está activo; custodio/copia fuera del host; autenticación tras restaurar. |
| F3 | Recuperación opt-in, cinco intentos limitados, ownership/generación, pausas, salud fresca y conciliación de resultados inciertos. | Reinicios y fallos físicos con cuentas de prueba autorizadas. |
| F4 | Salud por cuenta, señales vencidas, alertas deduplicadas, avisos del principal a los días 10/12/13/14, acuse humano y formularios accesibles. | Destino de avisos autorizado, recepción humana, escalamiento del receptor y programación de monitor fuera del host. |
| F5 | Preparación guiada, incidentes, conciliación, cuarentena cifrada, volumen nuevo detenido e identidad inmutable. | Revinculación/almacenamiento con una cuenta controlada; autorización de interrupción antes de cualquier prueba. |
| F6 | Pruebas automatizadas y carga sintética de 20 cuentas; CI/CD y comprobaciones productivas sin efectos comerciales. | Piloto físico 2 → 5 → 10 → 20. |
| F7 | Estados, marcas de tiempo e historial para observación. | Al menos 21 días reales y decisión de escala/transporte. |

Las fases que mezclan software y operación no se consideran físicamente completadas por superar pruebas sintéticas. Los 20 participantes de la prueba no son 20 sesiones reales ni infraestructura provisionada.

## Uso

**Ventas → WhatsApp → Números → abrir número** muestra Conexión, Teléfono principal, Recuperación y Configuración comercial. Registrar uso exige una declaración real. Configurar recuperación conserva las pausas y permisos comerciales; ninguna confirmación habilita envíos por sí misma.

[Guía de controles, API/MCP y recuperación](channel-session-continuity.md) · [Decisiones](adr-qr-continuity-2026-09-15.md) · [Evidencia local](evidence/qr-continuity/local-validation.json).

## Límites de esta ejecución

No se enviaron mensajes reales ni se activaron campañas, gasto o sesiones detenidas. No se provocaron logout, reinicios o reemplazos de volúmenes productivos para probar recuperación. No se eligieron nuevos destinos de notificación ni se ampliaron scopes del cliente MCP.

La validación de los formularios usa la compilación local con datos sintéticos. La comprobación autenticada de producción se completó por API y MCP; el acceso antiguo del navegador de Codex fue rechazado y una pestaña nueva de Chrome también requiere iniciar sesión. No se declara una revisión visual autenticada de producción mientras ese acceso siga pendiente.
