# FULL: artefactos de prueba fuera del checkout

El FULL51f72 terminó FAILURE con las21etapas PASSED y SOURCE_TREE_NOT_CLEAN. El workspace nativo no conservó su lista de diferencias. La inspección prueba que integración/E2E escriben JSON/PNG no ignorados bajo docs/evidence; Python, en reproducción localMac, dejó Git limpio. No se atribuye un listado nativo inexistente.

El driver fija COMMERCE_TEST_EVIDENCE_DIR a un directorio0700 único fuera del checkout. Los productores mantienen sus nombres/bytes/assertions mediante el helper compartido. .runtime sigue dentro del volumen compartido únicamente para configuración y mounts de las pruebas existentes. No se amplían ignores ni se limpian diferencias después de pruebas.

Al cerrar el intento, un manifiesto privado registra rutas relativas, tamaños y SHA256 de los outputs, además del statusGit exacto/hash y los hashes de archivos modificados. Una observación separada en stdout contiene ese manifiesto acotado (sin cuerpos de archivos); no tiene gate_name y no reemplaza el recibo FULL. La verificación de fuente y sus21etapas siguen obligatorias. Un fallo de captura no produce PASS. Límites explícitos:1024archivos,32MiB cadauno,256MiB total y512KiB manifiesto; symlinks/especiales de evidencias se rechazan.

Implementación aislada, sin modificación de51f72/publicación. El driver está embebido en verifier; una candidatura nueva exige imagen verifier/procedencia nuevas antes del siguiente FULL.
