# ADR V7 — Custodia de archivos del laboratorio

Decisión previa, 12-oct-2026. El broker es un puerto privado del host, nunca una
ruta que acepte storage_key, URL, rol o credencial del usuario. Relee el run y su
única operación INTENT, autentica el sobre cifrado de control y recompila la
lista exacta de materiales antes de adquirir bytes. El acceso al original usa
un pool API fijo con perfil activo, entorno REAL y referencia/version/hash
exactos; sólo lee assets, sin modificar configuración ni conceder permisos.

Las raíces físicas se configuran en el host y son distintas. Los nombres de
archivo se derivan de IDs/hash validados. Se rechazan enlaces simbólicos y
archivos que cambian durante una lectura. La copia verifica el ciphertext, el
base64, el hash de contenido y su tamaño; se cifra con otra key exclusiva del
laboratorio. La escritura exclusiva conserva una copia previa únicamente si
su descifrado/hash/tamaño son exactamente iguales. Un archivo parcial o
incierto bloquea; no se borra, sobrescribe ni interpreta como éxito.
Antes de publicar el descriptor se sincronizan tanto los bytes del archivo
como el directorio assets y su padre privado. Si cualquier fsync falla no se
acredita READY; la copia permanece para diagnóstico y recuperación exacta.

Cada lote está limitado a128MiB de contenido,20MiB por archivo y6000 referencias
(incluye duplicados de variante). El broker vuelve a verificar control y fuente
antes de publicar el recibo de la copia. No mantiene una transacción durante
I/O de filesystem. Los archivos copiados antes de un fallo quedan preservados;
no equivalen a READY ni autorizan ejecución. No realiza red ni entrega REAL.

Esta fase implementa únicamente archivos cifrados. Materiales link/access
necesitan un adaptador propio que preserve su semántica sin fabricar secretos o
contenido. La key del motor y su raíz privada todavía requieren composición del
host antes de un montaje funcional; no se reutiliza la key REAL en el proceso
que ejecuta el laboratorio.
