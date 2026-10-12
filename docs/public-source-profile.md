# Perfil público sintético

Este snapshot local deriva del código revisado, pero sus datos y textos son **fixtures de software**. No importa el historial Git, los resultados históricos de CI, recibos operativos, PDFs vendidos, material editorial, capturas, audios ni fotografías comerciales del repositorio privado. El repositorio original conserva sus referencias y permanece privado. La fuente pública tiene repositorio separado `MarioB19/commerce-os-core`, ID1414365450, creado el11-oct-2026. Actions está deshabilitado. Este árbol no acredita un FULL nativo ni instalación productiva.

## Contenido que permanece público

El código API/web/workers, contratos, migraciones, herramientas y pruebas; workflows y configuración de compilación; nombres e identificadores no secretos de proyectos, números de proyecto, cuentas de servicio, buckets, repositorio y dominios. Esos identificadores conservan los guards reales del sistema existente. No son autorizaciones, credenciales ni una configuración lista para desplegar desde el nuevo repositorio.

Las cuentas personales del operador proceden de configuración privada explícita. El publicador local sólo lee `~/.local/share/commerce-os-release-custody/operator-identity.json`: archivo regular 0600 de un solo enlace, fuera del checkout, sin enlaces simbólicos ni ancestros escribibles por terceros. El emisor Root sólo lee `/opt/commerce-os/private/operator-identity.json` con su lector Root protegido. Ambos requieren exactamente `schema_version: 1` y `accounts` con las claves `cloud_build` y `legacy_billing`, cuyos valores los configura el operador privado. No existe cuenta predeterminada, selector por entorno, host, proyecto ni aprobación en este contrato. No se debe copiar al Git. Cada cuenta se contrasta con la evidencia correspondiente; el archivo no reemplaza IAM ni la custodia de pruebas.

## Fixtures y cobertura

- Portal: 480 registros inventados, nueve grados, diez PDFs sintéticos válidos. `scripts/generate-public-portal-fixtures.py` regenera el conjunto determinista sin leer fuentes privadas. Se conservan la sesión, límites persistentes de intentos, filtro de permisos, descarga privada y comprobación de ausencia del catálogo en bundles públicos.
- `tests/fixtures/mcl`: 34 mensajes, 15 FAQ y 28 casos inventados; IDs, estados, esquemas, hashes de texto y herramientas prohibidas mantienen sus contratos. Los casos de acuerdo, precio divergente y comprobante no aprobado siguen comprobando esos límites. Ningún caso constituye una evaluación de IA real ni una conversación de cliente.
- Los textos predeterminados del ejemplo de catálogo, flujo, importación, audio y fixtures preescolares son sintéticos. Importes, estados y frases de aceptación conservan compatibilidad con los contratos del software; no son una oferta aprobada para publicación.
- `tests/fixtures/public-retirement-policy.json` describe sólo el contrato de retiro: páginas ausentes y workflows manuales que terminan con error. No simula recibos de respaldo. `docs/evidence/` queda disponible para salidas nuevas; no contiene evidencia histórica importada.
- Los teléfonos completos y JIDs de prueba revisados usan el rango ficticio NANPA 555-0100–0199. Los casos conservan identidades iguales/diferentes, normalización del sufijo y assertions de ocultamiento; no se presupone que un teléfono sea ficticio por aparecer en `tests/`. [Referencia del rango reservado](https://nanpa.com/numbering/555-line-numbers).

El marcador `PUBLIC_FIXTURE_PROFILE.json` y la etiqueta de imagen `org.commerce-os.content-profile=synthetic-public-v1` hacen que `install-mcl-portal.py` rechace este portal. La publicación `copy-runtime` debe conservar la imagen, SHA, manifiesto y entorno del portal ya instalado. No se atribuye el fixture público al portal productivo ni se modifica su origen.

## Gates pendientes antes de CI público y producción

1. Revisar el manifiesto de archivos y exclusiones local, la clasificación de los hallazgos y los resultados de pruebas. Inicializar únicamente una historia nueva del conjunto aprobado; no copiar refs, objetos, releases, logs, artifacts o metadatos del repositorio privado. El export local usa 0600/0700 por custodia: reconstruir los modos Git 100644/100755 indicados por el manifiesto al preparar el repositorio, sin quitar bits ejecutables de scripts.
2. Mantener Actions deshabilitado, como se verificó antes del primer push. Los tres workflows se conservan porque forman parte del contrato FULL; conservarlos no autoriza su ejecución ni el gasto.
3. Separar la identidad del verificador público y su almacenamiento de fuentes. La cuenta usada para el bootstrap privado puede leer archivos privados del bucket de staging y no debe entregarse a código público no confiable. Debe demostrarse que un PR no puede leer esas fuentes, secretos o artefactos privados.
4. La identidad observada está fijada en `infra/cloudbuild/public-repository.json`: ID1414365450 y App Google Cloud Build10529. Revisar installation/conexión, origen, OIDC, workflow y branch protection antes de habilitar CI. La instalación de la App y la identidad de verificación pública siguen pendientes; no se heredan del original. Los guards canónicos del repositorio privado permanecen cerrados para esta fuente y requieren una transición revisada; cambiar un nombre o usar este JSON no autoriza publicación. Los recibos y enlaces históricos siguen perteneciendo al repositorio privado original.
5. Ejecutar FULL completo sobre el **SHA exacto** final de la nueva fuente e imagen revisada. No se omiten etapas. El PASS de otro SHA o las pruebas locales parciales no aprueban este commit ni cierran F0.
6. Habilitar CI automática y publicación sólo cuando custodia, IAM, identidad, presupuesto, protección de rama, exclusión mutua del publicador y readback estén validados. Este borrador no hace esas mutaciones.

El original privado tampoco es apto para un cambio directo de visibilidad: conserva material comercial y datos personales en historia/logs, además de binarios grandes y superficies GitHub sin cobertura completa. El conjunto nuevo evita importarlos; no afirma haber borrado caches o referencias históricas de GitHub.

## Lector FULL compartido

El incremento del lector REST conserva las validaciones del publicador local y la identidad del bootstrap privado. Adquirir ADC y autenticar la lectura de fuente son tareas del controlador confiable todavía no instalado. El módulo no crea builds ni aprueba triggers y sigue rechazando que la fuente pública herede la identidad privada. La cuenta personal del CLI continúa siendo exclusivamente configuración privada mediante `operator_identity`. Las pruebas locales no acreditan un FULL nativo del nuevo SHA.
