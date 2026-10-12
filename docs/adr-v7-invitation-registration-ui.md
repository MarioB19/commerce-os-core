# V7 F2 — pantalla de alta por invitación

Decisión del 11-oct-2026 antes de implementar, como continuación de
[alta por invitación](adr-v7-invitation-registration.md).

La pantalla recibe exclusivamente el enlace extraído por el bootstrap y
conservado en memoria. Solicita nombre, correo invitado y contraseña; no permite
elegir perfil ni rol. La contraseña se descarta del estado al enviar y no vuelve
a mostrarse en errores. Una única llamada crea la identidad y acepta el enlace.

El cliente sólo clasifica como rechazos seguros los códigos y estados HTTP
exactos emitidos por esa ruta antes de confirmar una nueva identidad. Una
respuesta perdida, inválida o desconocida permanece incierta: no habilita otro
POST de alta. Tanto el éxito como la incertidumbre ofrecen iniciar sesión con
la identidad nativa y consultar la aceptación. El callback de login mantiene el
enlace en memoria en el contenedor de la vista; no se agrega a query strings,
storage ni URLs de navegación. Cambiar de enlace invalida respuestas anteriores.

El componente y cliente se prueban en aislamiento antes de registrar rutas o
montarlos en la aplicación. Esta evidencia no acredita envíos, altas reales ni
despliegue.

Antes de montar el componente, el cliente reconoce tanto el envelope cerrado
`{error:{code,message}}` del manejador canónico de la aplicación como el formato
cerrado de Fastify usado por el plugin aislado. En ambos exige código/mensaje
idénticos y la misma allowlist de estados HTTP; detalles adicionales o códigos
desconocidos permanecen inciertos. No se interpreta un error genérico como rollback.
