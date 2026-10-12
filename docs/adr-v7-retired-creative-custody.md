# V7 — Custodia del emparejamiento creativo retirado

Fecha: 2026-10-12. Estado: componente preparado, sin instalación nativa.

La migración0042 retiró los dispositivos creativos y sus emparejamientos. Las
rutas de dispositivo y de estudio no están registradas por `createApp`; la
configuración creativa sigue siendo otro módulo activo. Los hashes y posibles
cifrados del historial no son autoridad vigente ni contenido comercial REAL.

El componente020 exige el hash histórico0042 y verifica, bajo locks, que todos
los dispositivos están revocados con fecha y todos los emparejamientos están
expirados o consumidos. Si aparece uno activo, la transición se rechaza. No
revoca registros por su cuenta ni transforma un workspace NULL en un perfil.

Habilita y fuerza RLS con una política restrictiva falsa para ambas tablas. No
agrega una política permisiva, grants, roles, datos ni columnas. El runtime no
puede leer hashes/cifrados ni crear, modificar o borrar filas, incluso si se
agrega una política permisiva accidentalmente. La administración privilegiada
conserva los bytes originales como custodia; este componente no crea una ruta
HTTP para acceder a ellos. La lista de policies/RLS previa debe estar intacta;
un intento repetido o una política no revisada abortan antes del cambio.

El control global deberá clasificar estas dos tablas como historial cerrado y
preservar esta restricción. `creative_members` y el presupuesto global siguen
siendo autoridad/configuración compartida por perfil, con tratamiento distinto.
