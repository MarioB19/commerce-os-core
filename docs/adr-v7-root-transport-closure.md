# Clausura fija del transporte Root — 2026-10-11

El hook de arranque durable agrega imports al instalador canónico. Transferir
sólo el catálogo anterior deja incompleto el proceso remoto aun cuando el
package contiene las fuentes correctas.

`deploy-ci-client.py` define un catálogo ordenado de 22 scripts: el instalador,
sus dependencias previas, los nueve módulos/entrypoint boot, el contrato B02 y
los validadores de FULL/package con su bootstrap. El cliente ya está ligado por
hash a la imagen publisher; `NativeInstall` usa ese mismo catálogo cerrado y
exige exactamente esos archivos, en orden, más el TAR y el destino del run.
Ni el candidato, ni una variable, ni un manifiesto externo pueden ampliarlo.

Cada archivo sigue pasando por checksum local, checksum remoto antes y después
de custodia Root, número exacto de entradas y prohibición de symlinks. La limpieza
usa el mismo catálogo y el único entorno portal opcional histórico. Sólo se
ejecuta cuando systemd confirma estado terminal y PID cero; una ejecución
desconocida conserva staging para conciliación, sin repetir el arranque.

Las pruebas rechazan faltantes, duplicados, reordenamientos, nombres ajenos y
destinos alternativos. El smoke aislado de la rama integrada debe demostrar la
clausura real de imports antes de usar el bundle. Las pruebas locales no prueban
FULL, transferencia, instalación ni arranque de producción.
