# Laboratorio PITR aislado

`pitr-fixture.sh` usa exclusivamente datos sintéticos y pgBackRest cifrado local.
No lee `.env`, DATABASE_URL, credenciales nativas, producción ni backups reales.
La clave aleatoria vive en el entorno del proceso y desaparece con su tmpfs.

Construir `infra/pitr/Dockerfile.fixture` desde la raíz del repositorio con un
contexto Docker local elegido explícitamente. La base PostgreSQL está fijada por
digest; pgBackRest procede del repositorio Debian y su versión real se registra
en el recibo. Esta imagen de laboratorio no es una imagen de producción ni
acredita su gate de vulnerabilidades.

Antes de crear el contenedor, guardar sólo IDs de contenedores y nombres de
volúmenes preexistentes. Usar el ID de imagen construido, una etiqueta única y
salida en un directorio privado nuevo. Crear una vez con:

```text
--platform linux/arm64 --network none --read-only
--cpus 0.5 --memory 768m --pids-limit 128 --cap-drop ALL
--security-opt no-new-privileges
--tmpfs /tmp:rw,nosuid,size=640m,mode=1777
--tmpfs /var/lib/postgresql/data:rw,nosuid,size=1m,mode=0700,uid=999,gid=999
```

No montar archivos o directorios del host, no pasar variables del entorno ni
usar `--privileged`. El segundo tmpfs sustituye el VOLUME heredado de PostgreSQL.
Registrar el CID devuelto antes de `start -a`; guardar stdout/stderr privados y
limitar la ejecución a 420 segundos. Un timeout conserva el resultado incierto:
inspeccionar sólo ese CID y su etiqueta, sin crear otro intento automáticamente.

Aceptar únicamente salida cero y un solo recibo JSON con estado
`SYNTHETIC_POSTGRES_PITR_VERIFIED`, las comprobaciones completas y los negativos
de clave/WAL. Confirmar que el CID propio esté detenido y tenga su etiqueta
exacta antes de retirarlo por ID. Comparar después el inventario preexistente;
jamás usar prune, nombres genéricos o comandos que retiren contenedores ajenos.
Conservar logs y recipiente fallidos hasta explicar su causa.

El fixture espera replay pausado en el target nombrado antes de consultar el
dinero. El negativo de WAL exige el error específico de recuperación incompleta
y un proceso terminado; un fallo cualquiera de arranque no cuenta como PASS.
Los bytes finales se miden tras cuarentena del WAL del negativo. No equivalen
a capacidad de producción, RPO/RTO, servicio GCS o recuperación entre regiones.
