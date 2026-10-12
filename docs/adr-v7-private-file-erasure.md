# D18 — Borrado privado de archivos con custodia

Decisión previa, 12-oct-2026. La selección, plazos de retención y fence de backup
pertenecen al puerto DB canónico. El componente filesystem no decide edad ni
autorización comercial. Sólo recibe job UUID y SHA de manifest; su factory fija
la raíz privada y el puerto autenticado. No acepta path, storage key o lista de
archivos enviada por el usuario.

El manifest inmutable liga perfil, plan, inventario y backup, más cada asset y
su ciphertext exacto (hash y bytes). La admisión vigente se consulta antes de
cada link y unlink. Si falta hash cifrado, un inventario read-only previo debe
obtenerlo de candidatos autenticados antes de admitir el manifest. Un hash del
contenido plano no sustituye al ciphertext.

Cada trabajo mantiene un journal técnico durable y exclusivo. El proceso abre
raíces y archivos sin seguir symlinks, rechaza hardlinks, verifica inode/device,
tamaño/hash y cotas. Cuarentena vive dentro del mismo filesystem y sólo contiene
archivos de ese job. Nunca sobrescribe un nombre existente ni restaura un archivo
sobre otro. Node no expone rename no-replace portable: se usa link exclusivo y
unlink del nombre original, con estado durable que liga el único nlink2 esperado.
Un hardlink ajeno previo se rechaza. Se sincronizan ambos directorios; antes de
cada unlink se confirma de nuevo identidad, autoridad y journal.

La raíz0700 pertenece al UID del proceso. El puerto DB mantiene el lease de
writer exclusivo de ese namespace durante el trabajo. El módulo impide también
concurrencia local por raíz. Un fd O_NOFOLLOW y fstat/lstat comprueban identidad
inmediatamente antes del unlink. No existe unlink-by-fd condicional portable:
el lease y la exclusión de otros writers son prerrequisitos del host que cierran
esa carrera residual. El componente nunca presume proteger contra un proceso
privilegiado que incumpla deliberadamente dicho fence.

La pérdida de ACK se reconcilia mediante el mismo UUID, journal y filesystem.
Cada transición conserva un intent antes del efecto. Ausencia inesperada,
archivos intrusos o identidad distinta bloquean y conservan la cuarentena. Un
recibo terminal exige readback de ausencia de todos los archivos admitidos.
El journal no guarda teléfonos, textos, secretos ni paths de negocio: referencia
descriptores por hash. Las pruebas sólo usan archivos sintéticos locales; no se
monta el puerto ni se borra material productivo.

## Verificación local del componente preparado

28 pruebas con archivos cifrados sintéticos y operaciones reales de filesystem
cubren ausencia terminal, relectura del mismo job, diez puntos de ACK perdido,
fallo de sincronización de directorio en los tres efectos, vencimiento posterior
a la última autoridad, sustitución de inode, symlinks, hardlinks, intrusos y
concurrencia. Tipos completos y lint focal pasan. Las cotas son 1.000 archivos,
512 MiB cifrados por archivo y 2 GiB por manifest; no se acredita rendimiento con
esos máximos. El puerto DB y el lease nativo del host siguen pendientes de montaje.
