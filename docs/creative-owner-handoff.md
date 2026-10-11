# Entrega de MCP y Mac al propietario

Este mantenimiento tiene autorización `DELEGATED_SETUP` de la solicitud del08-sep-2026, SHA256 `dc6656c7b81d5af72b514a273a6d87d668642f27edba7feae3ef214c09d5aa3b`. Evita que la caducidad de las identidades sintéticas del piloto invalide la instalación propia de Brandon. No cambia contraseñas, sesiones de personas, roles comerciales, el temporizador de caducidad ni revisiones editoriales.

`scripts/creative-owner-handoff.ts` exige un input privado0600 con workspace, SHA256 del email original normalizado mediante `trim().toLowerCase()`, ID del piloto y su actor técnico, ID exacto del Mac y proyectos exactos. El email nunca aparece en el input, salida ni auditoría. La consulta debe encontrar exactamente un owner activo del mismo workspace. Un evento previo debe acreditar que el actor técnico pertenece al piloto delegado.

Tres acciones independientes, mediante la imagen publicada y el acceso administrativo existente:

```sh
node --import tsx scripts/creative-owner-handoff.ts inspect /pilot-private/handoff-input.json /pilot-private/owner-handoff
node --import tsx scripts/creative-owner-handoff.ts token /pilot-private/handoff-input.json /pilot-private/owner-handoff
node --import tsx scripts/creative-owner-handoff.ts transfer-mac /pilot-private/handoff-input.json /pilot-private/owner-handoff
```

`inspect` verifica el propietario sin alterar PostgreSQL. `token` crea exactamente una credencial revocable `cosp_` de30 días, sólo REAL, con los cinco scopes mínimos que usan las ocho herramientas MCP: `intelligence:read`, `intelligence:refresh`, `studio:read`, `studio:write` y `studio:produce`. Excluye también `intelligence:write` e `intelligence:analyze`, además de `studio:admin` y `studio:review`. `resource_ids=null` permite crear briefs nuevos dentro del workspace; sigue sujeto a la membresía activa del propietario, presupuestos e inputs autorizados del servidor. El token no puede crear o modificar búsquedas, disparar análisis OpenAI, conceder permisos, configurar proveedores ni aprobar contenido. El piloto utiliza la sesión técnica para crear búsquedas y analizar; sólo el primer refresh autorizado viaja por MCP con este token.

El ledger0600 y `mcp-token`0600 se escriben privadamente antes del INSERT. PostgreSQL conserva únicamente el hash de la credencial. Un lock transaccional serializa la operación; el token y los eventos de auditoría se confirman juntos. Repetir con el mismo directorio recupera el mismo token. Si falta el ledger de una operación ya registrada, si cambió el input o si el token fue revocado, el script falla; nunca crea otro token silenciosamente. La salida contiene sólo IDs, scopes, plazo y ruta privada, nunca el secreto.

`transfer-mac` sólo acepta plataforma `darwin-arm64`, equipo no revocado, propietario técnico esperado, consentimiento previo de pairing y lista exacta de proyectos REAL del workspace. Debe estar ocioso: rechaza intentos RUNNING y trabajos pendientes asignados al equipo. Cambia su propietario e incrementa versión dentro de la misma transacción que la auditoría; conserva hash del token y proyectos. Repetir no vuelve a incrementar versión. No toca el equipo Windows y preserva la expiración de las cuentas del piloto.

Para la ejecución real, primero se verifica el SHA desplegado, luego el match del propietario y el ID del Mac ya conectado. El fichero privado se transfiere por el acceso autenticado existente y el token se entrega sólo al archivo de configuración privada del MCP. Revocación y renovación posterior se hacen desde la interfaz normal de API y tokens del propietario.

Verificación: seis pruebas PostgreSQL aisladas comprueban match de propietario, secreto privado y cinco scopes, denegación efectiva de escritura/análisis/admin/review mediante `creativePermission` incluso para un token cuyo actor es owner, reanudación, rechazo de recreación tras revocación, rollback del token/transferencia cuando falla auditoría, y denegación para Windows, proyectos distintos o trabajo pendiente. Estas pruebas no demuestran que se haya emitido un token real ni transferido un Mac; esa evidencia se registra después de la ejecución.
