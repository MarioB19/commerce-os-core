# Snapshot público — revisión local

Candidato local para `commerce-os-core`, con historia nueva propuesta. El repositorio original permanece privado e intacto. Este directorio no tiene Git, remoto ni autorización de ejecución externa.

El código y los guards de destino no secretos se conservan. Los contenidos comerciales y datos personales se separan mediante fixtures sintéticos y configuración privada del operador. Los tres workflows están presentes; Actions debe deshabilitarse en el repositorio nuevo antes del primer push futuro.

Consulta [perfil, límites y pasos de publicación](docs/public-source-profile.md). La instalación del portal sintético está expresamente bloqueada. La publicación de runtime debe conservar el portal instalado con su SHA e imagen anteriores.

Las pruebas locales no sustituyen FULL del SHA exacto. CI pública, App/OIDC, IAM aislado del staging privado, protección de rama y publicación canónica siguen pendientes. No ejecutar publicadores ni copiar historial o metadatos GitHub privados desde este borrador.
