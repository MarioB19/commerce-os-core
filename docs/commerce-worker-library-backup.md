# Biblioteca creativa: backup y restauración local

La copia de PostgreSQL conserva el snapshot transaccional. Este complemento descarga una biblioteca seleccionada, sus recetas, conformidades, jobs, artefactos y revisiones con SHA verificable. Los archivos READY son inmutables; la metadata se recorre en páginas y se declara `PAGINATED_METADATA_IMMUTABLE_ASSET_HASHES`. No sustituye el snapshot DB ni afirma consistencia transaccional de varias páginas.

El operador necesita un token humano privado con `studio:read` y acceso actual a los proyectos seleccionados. `--token-file` debe ser un archivo regular privado (0600 en macOS); su contenido nunca entra al backup. Cada URL de descarga se pide justo antes de transferir y permanece sólo en memoria. No se exportan claves de proveedores, tokens, claves internas de R2 ni URLs firmadas.

Usa Node 24 del paquete interno de Commerce Worker o la herramienta administrativa de desarrollo. El destino debe ser NUEVO y su carpeta padre ya debe existir. No se reemplazan archivos ni se siguen enlaces simbólicos. El límite total predeterminado es 2 GiB y cada archivo admite 500 MiB; `--max-bytes` permite una reserva explícita hasta 20 GiB. Para una copia independiente del bucket, seleccionar una unidad con capacidad y verificar el backup antes de depender de él.

```sh
"$HOME/Applications/Commerce Worker.app/Contents/MacOS/commerce-node" \
  scripts/creative-library-backup.mjs \
  --origin https://commerce-os.inovaris.online \
  --token-file /ruta/privada/mcp-token \
  --project UUID_PROYECTO \
  --destination "$HOME/.local/share/commerce-os-backups/copia-nueva" \
  --environment REAL
```

`--project` admite una lista de UUID separados por coma. Para incluir el journal local añade `--journal /ruta/explicita/journal.json`; el archivo debe existir, ser regular y no exceder 8 MiB. Se guarda como `journal.archive.json`, sin rutas locales, URLs ni credenciales, con `archive_only:true` y `replay_allowed:false`. No se coloca en una carpeta activa del worker.

El resultado contiene `metadata/<project>/<page>.json`, `assets/<asset-id>`, `manifest.json` y `receipt.json`. El recibo se genera después de transferir/verificar los bytes. Un fallo de descarga deja una carpeta incompleta sin recibo de finalización; el operador debe usar un nombre nuevo al reintentar. La herramienta verifica todos los hashes, tamaños y el inventario; rechaza archivos añadidos sin declarar.

```sh
"$HOME/Applications/Commerce Worker.app/Contents/MacOS/commerce-node" \
  scripts/creative-library-restore.mjs \
  "$HOME/.local/share/commerce-os-backups/copia-nueva" \
  /Volumes/KINGSTON/CommerceOSRuntime/restores/restauracion-nueva
```

La restauración verifica el origen antes de crear destino y vuelve a verificar la copia. Es un archivo local para revisión: no escribe R2, no crea devices, no conecta proveedores, no importa jobs activos ni reproduce operaciones. La recuperación de DB se realiza por `scripts/restore.mjs`, que congela efectos y revoca autorizaciones. La reconexión de un dispositivo requiere pairing nuevo y consentimiento humano.

Evidencia de implementación: seis pruebas con HTTP sintético identificado verifican streaming, SHA, journal saneado, permisos privados, destino nuevo, límite, corrupción, symlinks, archivos no declarados y restauración sin replay.

## Copia real verificada

El 8 de septiembre de 2026, a las 20:06 UTC, se completó una copia de R2 al SSD interno del Mac y una restauración en una carpeta nueva de KINGSTON. Las unidades se comprobaron distintas; había 27.380.617.216 bytes libres en la interna antes de empezar. Se incluyeron los dos proyectos originales, el brief LINK y el brief creado por MCP: 49 objetos READY, cuatro páginas de metadata y un journal archivado, 54 entradas y 410.208.902 bytes. Todos los SHA, tamaños e inventario coincidieron tras restaurar; las carpetas quedaron 0700 y los archivos 0600.

El manifiesto compartido de origen y restore tiene SHA256 `f103fd4b288d7c5ad2d2aee4ad0a485ee2511ac0a64da2b3321229da85f7b69f`. La copia reside en `~/.local/share/commerce-os-backups/creative-library-2026-09-08T20-04-50-527Z`; la restauración en `/Volumes/KINGSTON/CommerceOSRuntime/restores/creative-library-2026-09-08T20-04-50-527Z`. Los recibos privados conservan los paths completos. No se copiaron credenciales ni URLs firmadas, no se escribió R2 y no se reprodujeron jobs. Es una copia independiente local, no una copia adicional en la nube. [Evidencia saneada](evidence/creative-v1/library-real-backup-restore.json).

Este primer snapshot se conserva como histórico anterior al piloto final de caché entre jobs.

Después de verificar la publicación del servidor `362afed1` y detener el Worker se completó otro backup y restore nuevos: los mismos cuatro proyectos, 59 objetos READY, cinco páginas de metadata y un journal archivado, 65 entradas y 471.626.058 bytes. La metadata incluye los cuatro jobs REVIEW y 20 artefactos, incluidos los dos jobs de caché y sus diez outputs. Se verificaron todos los hashes, inventario y permisos 0700/0600 en ambas ubicaciones, y la ausencia de credenciales/URLs firmadas en metadata y journal.

La copia final está en `~/.local/share/commerce-os-backups/creative-library-final-362afed1-2026-09-08T20-41-56Z`; el restore en `/Volumes/KINGSTON/CommerceOSRuntime/restores/creative-library-final-362afed1-2026-09-08T20-41-56Z`. El timestamp identifica la preparación del destino; la transferencia empezó después de terminar el despliegue. Ambos manifiestos tienen SHA256 `5a9e49219df5d1e8823971a91eb25a630eeb96cf42ee095ec9b6716abea2750f`. No se reemplazó la copia anterior ni se reprodujeron jobs. [Backup y restauración final](evidence/creative-v1/library-final-backup-restore-362afed1.json).
