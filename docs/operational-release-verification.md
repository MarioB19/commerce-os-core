# Publicación del cierre operativo y dashboard

Publicación vigente: **08-sep-2026 a las 01:19:42, México (07:19:42 UTC)**. Código `376f675144d576e8ca6dc7734f6b8f17e45ade79`, release `ci-34197160928-1-376f675144d5`, [CI/CD 34197160928](https://github.com/MarioB19/commerce-os/actions/runs/34197160928) completado con `Deployment SUCCEEDED`. El artefacto `deployment.json` registra finalización a las `2026-09-08T07:19:42.112919+00:00`. La comprobación HTTPS posterior quedó aprobada en sesión nueva, incluida la corrección móvil y la actualización de Meta. [Evidencia completa](evidence/operational-closure-production.json).

REAL es el contexto predeterminado de las rutas normales. El laboratorio sigue aislado. La interfaz azul, API y cliente, comprobantes, controles de entrega y warm-up persistente están publicados. El dashboard recupera el balance, filtros y comparación de Dashboard WA; [contraste con las notas brasileñas](brazil-reference-validation.md).

**Corrección móvil instalada:** la inspección productiva anterior detectó filtros demasiado estrechos, aunque la prueba de desbordamiento pasó. `376f675` corrige la rejilla; CI verifica anchura legible, altura táctil y uso de fecha/producto en **320 y 390 px**, dentro de **66/66 E2E** aprobadas. El único cambio de aplicación frente a `17a7340` es `apps/web/src/pages/campaign-performance.css`; backend sin cambios. HTTPS confirmó nueve controles de al menos 240 × 44 px en ambas anchuras, sin desbordamiento; la captura de 390 px también se revisó visualmente. [Hallazgo y pruebas](evidence/dashboard-mobile-correction.json).

## Verificación del release vigente

- 123 unitarias, 242 integraciones (+1 QR optativa omitida), **66/66 E2E** y 43 pruebas Python aprobadas en CI/CD 34197160928, incluida la corrección móvil. Tipos, lint, build, recuperación y auditoría aprobados.
- El artefacto de instalación confirma seis servicios sanos, 28 migraciones, `real_dispatch_frozen: true`, paridad web HTTPS y cabeceras de identidad verificadas por el instalador; infraestructura y otros sitios preservados. No registra llamadas al proveedor durante el despliegue.
- Sesión HTTPS nueva a las 07:22 UTC: REAL, un GET del dashboard durante 45 s, cero errores HTTP/JavaScript, filtro de producto correcto y gasto conservado. Controles legibles sin desbordamiento a 320/390 px; warm-up instalado y apagado. [Verificación](evidence/dashboard-production-verification.json).
- Actualizar a las 07:23 UTC: un POST 202 creó un job nuevo, seguimiento exclusivo hasta SYNCED y dos informes totales (inicial y uno posterior al job), con revisión cambiada y cero errores. [Ensayo](evidence/dashboard-production-refresh.json).
- Inventario posterior al despliegue, 07:21 UTC: catálogo completo conservado (1 producto, 2 ofertas, 3 flujos y 6 materiales/accesos), metadatos/hashes coincidentes y canal sin envíos. SMTP versión 2 habilitado con credencial almacenada; cabeceras de identidad no-store/no-referrer correctas. Esto no acredita recepción de correo ni descifrado de archivos productivos. [Preservación](evidence/closure-production-preservation.json).
- La observación de staging continúa como `EXISTING_OBSERVATION`, con `source_sha: 17a7340ab7468d0bbcce4e28e0440209d49b1b6f`; no reinicia ni acredita 24 h completas.

## Histórico — publicación y comprobación de 17a7340

[CI/CD 34194173542](https://github.com/MarioB19/commerce-os/actions/runs/34194173542) instaló `ci-34194173542-1-17a7340ab746` el 08-sep a las 00:41 México, con `deploy=success` y `Deployment SUCCEEDED`. [Evidencia conservada](evidence/operational-closure-production-17a7340.json).

- 123 unitarias, 242 integraciones, 65/65 recorridos de navegador y 43 pruebas Python; una QR optativa omitida. Tipos, lint, build, recuperación y auditoría aprobados. La auditoría no encontró vulnerabilidades conocidas.
- Seis servicios sanos, 28 migraciones, paridad del paquete con HTTPS, cabeceras de identidad y otras aplicaciones del VPS preservadas.
- Sesión productiva nueva: REAL, un GET del dashboard durante 45 s, cero errores HTTP/JavaScript, filtros de producto correctos y móvil de 390 px sin desbordamiento.
- Actualizar: un comando 202, seguimiento exclusivo de su job hasta SYNCED, y exactamente un informe nuevo después del resultado. Sin reenvíos inmediatos a Meta ni cambios de anuncios. [Registro histórico](evidence/operational-closure-production-17a7340.json).
- Catálogo completo conservado: 1 producto, 2 ofertas, 3 flujos y 6 materiales/accesos. Metadatos/hashes iguales; SMTP versión 2 habilitado con credencial presente. No hubo cambios de contraseña ni mensajes externos. [Registro histórico](evidence/operational-closure-production-17a7340.json).

## Cómo ver las métricas actuales

En la comprobación HTTPS vigente de `376f675`, **Campañas → Periodo → Este mes** mostró el corte del 1 al 8 de septiembre con **$479.58 MXN** de gasto, agrupado bajo **Preescolar** por el nombre de la campaña. El gasto pertenece al 1 de septiembre. Últimos 7 días empieza el 2 y muestra $0: no es un error de API ni datos de simulación. Ingresos y ventas por comprobante son 0. Las etiquetas extraídas no crean productos de catálogo ni atribuyen ventas. [Comparación del mismo periodo antes/después](evidence/dashboard-production-periods.json) · [Escritorio](evidence/dashboard-production-month-1440.png) · [Móvil](evidence/dashboard-production-month-390.png).

## Operación que continúa pendiente

Warm-up está **instalado y apagado**. El único número productivo sigue FAILED, sin identidad verificada ni envíos; necesita vinculación humana y un pool propio elegible. La publicación no lo clasifica como BANNED ni habilita permisos comerciales.

La observación sintética de 24 h arrancó en el **VPS**, con red/base/secretos propios e imagen de `17a7340`. El despliegue de `376f675` conserva esa observación y su SHA; el backend es idéntico, pero no se etiqueta el ensayo como ejecutado con la imagen nueva. Primera muestra histórica: `2026-09-08T06:41:40.794257+00:00`, 1 muestra, 0 fallos y 0 segundos observados. La primera finalización posible es `2026-09-09T06:41:40.794257+00:00` (**09-sep 00:41:40 México**) si cumple duración, continuidad y contadores; esa fecha por sí sola no acredita el resultado. [Inicio persistido](evidence/staging-soak-vps-start.json). El ensayo local previo se detuvo conservando su volumen: 103 muestras, 6138.96 s, 0 fallos; no se suma al ensayo del VPS.

Siguen pendientes el piloto comercial con receptores acordados, IA con proveedor/presupuesto, recepción de materiales/SMTP/alertas, backup externo y monitor fuera del host, validación humana de accesibilidad, 30 días efectivos de warm-up y 48 h entre tandas. [Matriz y ficha única](operational-closure.md) · [Runbook](operational-runbook.md). **Software publicado; cierre operativo completo pendiente.**
