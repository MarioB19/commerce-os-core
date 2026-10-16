# Selector de perfil y frontera de contenido D18

Fecha:2026-10-12. Estado: componente preparado, sin instalación nativa.

`profile_session_context` sólo contiene sesión/usuario/perfil, versiones de CAS y
fecha de cambio. Es autoridad compartida de identidad; puede cambiar de perfil y
se elimina por CASCADE al revocar sesión/membresía. No contiene conversación ni
copias de contenido.030 genérico exige GUC y perfil inmutable, lo que impediría el
bootstrap020 fuera de perfil. No debe cambiarse esa semántica del selector.

El componente adicional030 autentica la estructura, ACL y ambos procedimientos
020 por hash antes de revocar INSERT/UPDATE directos de API. No agrega grants.
El único escritor de aplicación queda dentro del SECDEF020 con sesión nativa,
membresía, locks, CAS y reloj final. SELECT permanece sujeto a RLS; revocaciones
por las FK CASCADE existentes se conservan. No se altera030 original.

El generador de guard de contenido y028 excluyen exactamente esa tabla después
de verificar estructura sin JSON/campos adicionales, ACL select-only API y hashes
más ACL de los dos procedimientos. Cualquier drift cierra la generación. Ni el
lector D18 ni el futuro ejecutor deben recibir escritura sobre el selector; los
fingerprints finales031 deberán incluir esta frontera. Memberships no se excluye
por esta decisión y profiles conserva guard/epoch existentes.

La selección puede confirmarse durante una lease de contenido: sólo cambia
metadata de autoridad y no modifica contenido, épocas, reservas o derechos de la
membresía. La transacción comercial posterior vuelve a validar selección/perfil
nativos y el guard030 detiene escrituras REAL durante la lease. La evidencia local
prueba ambos hechos separados, además de rollback CAS y revocación por cascada.

Los fixtures históricos de inventario028 y cerco030 aplican también este
componente antes de sus generadores. No cambian los casos, conteos ni guards;
la prueba combinada nueva acredita la precondición nativa y el FULL deberá
ejecutar otra vez ambos fixtures completos.

## Lectura autenticada bajo ACL cerrada

El ensayo HTTP compuesto detectó que `FOR SHARE` sobre `profile_session_context`
requiere privilegio UPDATE, retirado por este componente. La lectura autenticada
conserva `FOR SHARE` sobre la fila nativa `session`, adquirido antes de leer la
selección. Ambos escritores canónicos (selector020 y el helper SQL previo) toman
`FOR UPDATE` sobre esa misma sesión antes de cambiar la selección. Por ello la
lectura del hijo puede ser SELECT sin un segundo lock: no se devuelve UPDATE a la
API, no se añade otro SECURITY DEFINER y no cambia CAS. La revocación de la sesión
sigue bloqueada por el lock padre y la autoridad se revalida al finalizar. El
ensayo concurrente debe acreditar que el selector020 espera hasta el COMMIT del
handler; las escrituras directas del hijo permanecen denegadas.
