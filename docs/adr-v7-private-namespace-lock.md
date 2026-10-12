# D18 — Exclusión del namespace privado durante I/O

12-oct-2026. Decisión previa a la implementación del lock de archivos.

Cada lector o escritor de archivos toma un lock SHARED del namespace privado;
el borrador toma EXCLUSIVE antes de autenticar su manifest y conserva el lock
hasta completar el journal y comprobar ausencia. No mantiene una transacción
de PostgreSQL durante I/O. La autoridad de negocio se revalida por separado.

Node abre un archivo técnico fijo con O_NOFOLLOW, sin truncarlo, dentro de la
raíz canónica 0700 del mismo UID. Verifica archivo regular 0600, nlink1 e identidad
del directorio y del nombre. Un proceso mínimo adquiere flock no bloqueante sobre
el descriptor heredado. El descriptor original queda abierto en Node durante
todo el callback; la salida del helper no libera ese lock. No hay expiración,
robo de leases, PID reutilizable ni archivo de lock que deba borrarse al salir.
Se libera cerrando el descriptor incluso ante excepción. El token opaco queda
inservible al terminar y detecta reemplazo de directorio o archivo técnico.

Linux usa `/usr/bin/flock`; desarrollo macOS usa `fcntl.flock` del Python del
sistema. Ambos invocan el mismo protocolo de descriptor heredado. La imagen
runtime debe probar la presencia del binario Linux, y la verificación debe
probar exclusión real entre procesos, no sólo mocks. Filesystems de red no están
admitidos por este protocolo; la raíz productiva es el volumen privado local.

Semántica usada: los locks pertenecen a la descripción de archivo abierta y
persisten hasta cerrar todos los descriptores duplicados. Fuente primaria:
[Linux man-pages, flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html).
Este lock es cooperativo: todos los accesos runtime deben montarlo antes de
habilitar purga. No acredita defensa contra un administrador que lo ignore.

El namespace actual es compartido por los perfiles del mismo volumen. El modo
no bloqueante devuelve BUSY sin iniciar trabajo; los consumidores deben tratarlo
como indisponibilidad transitoria, conservando intenciones y sin repetir efectos
externos. La medida del tiempo de exclusión y su impacto en disponibilidad sigue
siendo un gate del montaje y de carga, no una garantía dada por esta primitiva.
