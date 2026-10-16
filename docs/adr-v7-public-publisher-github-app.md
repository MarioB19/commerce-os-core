# Credencial fija de la App del publicador público

Fecha: 2026-10-11. Estado: código y pruebas locales; prueba nativa pendiente.

El publicador de `MarioB19/commerce-os-core` utiliza su App e instalación propias.
El módulo `cloudbuild_github_app_credential.py` fija los IDs de App, instalación y
repositorio, SA, versión numérica de Secret Manager y SHA256 de la clave pública
DER. Su configuración debe coincidir exactamente con esas identidades. No existe
un selector de repositorio, clave o permisos en requests, variables de entorno o
archivos del candidato. El perfil privado SHADOW conserva su credencial actual;
el transformador de fuente pública cambia el seam del worker de forma explícita.

La clave se obtiene con ADC de la SA del publicador, por la versión exacta de
Secret Manager. Se valida nombre, tamaño, base64 y CRC32C. `cryptography` carga la
RSA sólo durante la firma, comprueba la clave pública DER y emite un JWT RS256 de
60 segundos. No se escribe la clave en archivos, argumentos o logs. Se borra el
buffer mutable de entrada al terminar; Python y su biblioteca criptográfica no
garantizan el borrado inmediato de todas las copias internas inmutables. El
controller y el verifier no acceden a la clave; el import de crypto es diferido.

Antes del único POST se comprueban instalación, cuenta, selección de repositorios,
permisos exactos, ausencia de suspensión, identidad de workload y vigencia del
JWT. El body limita explícitamente `repository_ids` al único ID público y a
`contents:read`, `deployments:write`, `administration:read`,
`actions_variables:read` y `metadata:read`. El token permanece en memoria y no se
entrega hasta comprobar permisos, TTL y un GET completo de repositorios con
exactamente el mismo repositorio público. El transporte rechaza redirects,
paginación, compresión y respuestas fuera de cota. Los errores no incluyen bodies
ni credenciales. El límite es 128 KiB por respuesta, cuatro respuestas por
adquisición, más lecturas de identidad/ADC del proveedor; cada lectura tiene un
plazo y socket acotados, dentro de los 900 segundos del worker.

`acquire()` sólo permite un intento por instancia, incluso si el POST devuelve un
resultado incierto. El worker usa `acquire_once` con el journal durable de su
ejecución actual, también al conciliar una publicación anterior. Exige CAS nuevo,
hash del payload, intento y generación antes de leer la clave o adquirir el token.
Después de leer Secret Manager y la instalación, vuelve a ejecutar la admisión
actual inmediatamente antes del POST. La lectura final de identidad precede
ese fence; después sólo se comprueba localmente la vigencia del JWT, sin otro I/O.
El resultado persiste sólo identidad/expiración, sin bearer; si es incierto se
conserva el intent y se descarta el acceso al token en memoria. Otra instancia
no puede repetirlo. El journal histórico de la publicación no se modifica.
El resultado conserva
`deployment_write_proven:false`; sólo POST y GET de Deployment auténticos pueden
acreditar esa capacidad. El token no da autoridad para omitir FULL, package,
presupuesto, pausa, main vigente ni instalación/HTTPS de Root.

Validación local: 25 pruebas con RSA generada sólo en memoria, firma verificada,
CRC32C conocido, error de checksum/version, identidades ajenas, permisos mayores,
JWT vencido durante lectura, token corto, repositorio privado/extra, respuesta
incierta sin retry, cotas y errores sanitizados. Siete pruebas usan el journal
real con almacenamiento sintético y verifican CAS ambiguo, resultado perdido,
reinstancia, reserva vencida y respuestas CAS adulteradas sin un segundo mint.
Otra regresión vence la admisión durante el GET de instalación y comprueba cero
POST, conservación del intento y descarte del bearer.
La imagen publisher incorpora
`python3-cryptography` de Ubuntu actualizado; la imagen FULL necesita la misma
dependencia para ejecutar la prueba RSA obligatoria. Faltan reconstrucción/scan
de esas imágenes y el probe nativo; las pruebas no utilizan material real.

Contratos oficiales consultados: [token de instalación de GitHub App](https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28#create-an-installation-access-token-for-an-app),
[autenticación de instalación](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
y [integridad de Secret Manager](https://docs.cloud.google.com/secret-manager/docs/data-integrity).
