# Decisión: cuarentena del perfil durante la copia

La copia conserva perfiles WAHA de cuentas UNKNOWN. El PUT general exige
estado desconectado y ausencia de comandos incluso al deshabilitar, por lo que
no puede cerrar la salida del proveedor mientras se concilia la cuenta.

Se añade un POST de deshabilitación estricta para WAHA/Cloud: permiso owner o
integrations:write del recurso, revisión del perfil e idempotencia. Lee el
perfil vigente bajo los locks existentes y sólo cambia enabled a false mediante
saveIntegrationSetting. Conserva label/config y todos los valores privados;
no llama al proveedor ni modifica cuentas, sesiones, órdenes o ownership. El
historial y la revisión operativa registran la cuarentena; reenviar el mismo
input devuelve el resultado guardado. El PUT de habilitación/rotación conserva
sus guards actuales. Una deshabilitación no acredita logout, aislamiento del
host anterior ni readback remoto; éstos siguen siendo gates independientes.

Validación prevista: UNKNOWN con orden pendiente; conservación de configuración,
secretos y estado remoto; CAS/idempotencia; permiso de viewer; rechazo de campos
que intenten activar o rotar; rechazo de otros tipos. No se ha instalado.
