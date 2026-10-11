# Excluir cuentas borradas del selector de perfiles

Fecha: 2026-10-10. Decisión previa a la implementación; publicación pendiente.

La habilitación conservadora de WAHA_01 se detuvo sin mutación: el selector
incluía una cuenta histórica borrada con sesión archivada junto a la cuenta
vigente, cuyo estado histórico WORKING y sesión detenida cumplían las guardas.
La lectura posterior conservó perfiles deshabilitados y política REAL98. No se
intentará desconectar con un perfil deshabilitado ni modificar ese historial.

El selector aplicará `NOT (body ? 'deleted_at')`, la misma semántica de cuentas
vigentes usada por catálogo y Números. No se filtran sesiones por `archived_at`:
una cuenta que no está borrada y tiene una sesión archivada sigue bloqueando la
excepción congelada. Permanecen todas las guardas de versión, secretos, quietud,
leases, efectos y autorización comercial. No cambia el esquema ni los workers.

La regresión reproduce una cuenta borrada y archivada que comparte el perfil
con una cuenta vigente WORKING/STOPPED; verifica la habilitación sin alterar
cuentas, sesiones, ownership ni secretos y conserva la idempotencia. Otro caso
rechaza una cuenta vigente archivada sin cambiar perfiles ni política. El FULL,
paquete, instalación y readback del nuevo SHA siguen pendientes; el fallo
original y los recibos de respaldo y restauración conservan su procedencia.
