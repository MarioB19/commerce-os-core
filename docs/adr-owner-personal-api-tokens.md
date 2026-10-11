# Acceso personal owner por API — 15-sep-2026

Brandon autorizó una credencial nueva para administrar toda su plataforma mediante API/MCP y el uso de Google Cloud para emitirla. Un token de servicio mantiene sus scopes y su identidad service/viewer; no se amplían credenciales existentes ni se convierten en sesiones humanas.

Se incorpora un token personal de usuario (`cos_pat_`), almacenado en una tabla propia sólo como hash. Representa al owner real y revalida su membresía activa en cada petición y dentro de cada mutación. `/v1/me` identifica `authentication_method=personal_access_token`; los eventos registran actor `personal_api` e identificador de credencial. Sus permisos son los del owner vigente, en los entornos concedidos. No crea una cookie ni cambia contraseñas.

Alta, consulta, revocación y rotación tienen API propia, expiración obligatoria, confirmación explícita e idempotencia. Una credencial personal no puede emitir otra con mayor duración o entornos que ella. El bootstrap inicial requiere administración autenticada del VPS, coincidencia exacta del owner, motivo y digest de la autorización actual; conserva un ledger privado y audita la emisión en la misma transacción. Restaurar una copia, cambiar o restablecer la contraseña revoca estos tokens.

La administración incluye catálogo, números, usuarios, integraciones y controles expuestos por `/v1`. Cambios de contraseña y recuperación conservan el contrato de identidad y sus verificaciones. Autorizar una credencial no activa envíos, campañas, warm-up, QR ni gasto; sus controles de operación permanecen. La aplicación se publica por CI/CD; Cloud Shell sólo ejecuta el bootstrap del release instalado y verificado. Se entrega el secreto cifrado al almacén privado del Mac, nunca en logs o notas.

Validación: autenticación owner real, separación de servicios, membresía/expiración/revocación, entornos, auditoría e idempotencia, alta y retiro de canal sintético, cero comandos/outbox y rotación sin ampliar alcance. La evidencia productiva se registra después del despliegue.

La rotación explícita de un token propio permite renovar su plazo hasta 90 días desde la solicitud, sin ampliar entornos. Crear otro token conserva el límite de plazo del emisor. Esto permite renovar el acceso desde la propia API mientras el token siga vigente, con confirmación y auditoría. No hay renovación automática.
