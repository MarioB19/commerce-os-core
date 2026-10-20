# Techo del medidor del controlador, 20-oct-2026 (Agente: Claude)

El 20-oct el medidor de solicitudes del controlador llegó exactamente a
40,000,000 ms de reservas en octubre (40,000 s vCPU; 80,000 GiB-s con 2 GiB),
después de ocho FULL y sus atestaciones en el día. El tick SOURCE del FULL de
`785b9d37` reservó 5 s y su extensión a 450 s falló en `validate()` con
`METER_MONTHLY_CEILING`, antes de cualquier CAS o trabajo
(`STOP_PRESERVE CONTROLLER_ADMISSION_STOP` en `CONTROL_INSPECT`). Root cerró la
fila activa como COMPLETED conservando su cota; no hubo reembolso.

Cambio operativo aprobado por Brandon en el chat el 20-oct («Sí, sube el
techo»): mismo procedimiento del 19-oct. Se deriva la imagen desplegada del
controlador
`controller@sha256:a9072aa05d680dba97c9f58eae648cb629c7801f54c66ef257e6769d17b800a8`
y se reemplaza sólo `cloudbuild_runtime_meter.py`, con techos mensuales de
50,000 s vCPU y 100,000 GiB-s. Se conservan el límite de 2,000 solicitudes,
la cota de 450 s por solicitud, todas las filas, cargos, exclusiones y
recuperaciones. Sin reinicio del medidor ni del ledger.

Costo conservador adicional, con las tarifas tier-1 de Cloud Run
(USD 0.000024/vCPU-s y USD 0.0000025/GiB-s): 10,000 × 0.000024 + 20,000 ×
0.0000025 = USD 0.29 antes de impuestos, USD 0.34 con el 16%, por mes. Es un
modelo de reservas, no una factura medida ni un tope del proveedor. El techo
del proyecto sigue en USD 100/mes. Fuente: https://cloud.google.com/run/pricing

Verificación: la imagen derivada
`controller@sha256:e7c018db3dd1f5f227c321dc0994e0632c1d453b47f1a45ec8c8f0f223e1f852`
difiere de la base sólo en ese archivo (permisos, dueños y hashes de los demás
archivos de `/opt/trusted` idénticos; el de la base coincide con `main`). El
servicio se actualizó con ambos controles en pausa (revisión `00008-4kt`; el
resto de la plantilla sin cambios). El siguiente tick SOURCE extendió a 450 s y
subió la fuente. Pruebas del medidor: 26 en verde, incluida la regresión del
mes agotado en 40,000 s.
