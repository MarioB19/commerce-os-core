# Transporte privado del paquete de CI — 13-sep-2026

La cuota de Actions bloqueó los runs 34728383761 y 34761718817. Se respaldaron, comprobaron y retiraron 6.49 GB de artefactos antiguos; GitHub demora 6–12 horas en recalcular esa cuota. El paquete y su prueba siguen siendo requisitos de publicación.

El mismo workflow conserva build, verificación, dependencias entre jobs, entorno production, OIDC, main vigente, manifiestos, hashes, respaldo e instalador. Para main guarda los paquetes y evidencias en releases **draft del repositorio privado existente**. No publica anuncios, mensajes ni una release pública; no compra almacenamiento. Ramas/PR conservan Actions artifacts.

Cada transporte tiene identidad de SHA, run, intento y clase. El job de paquete entrega el ID de release y hash del manifiesto al job de despliegue; éste verifica ambos y todos los archivos descargados. Un reintento no sobrescribe assets: verifica los existentes antes de reutilizarlos. Los jobs verify, package y deploy reciben contents:write para el transporte de drafts; la ejecución del transporte sólo se permite en main. No hay nueva credencial duradera. Se rechazan repositorios públicos, referencias diferentes de main y destinos inesperados.

Las releases son recuperables y permanecen privadas para auditoría. Su retiro requiere antes una copia comprobada y conservar la última publicación válida. La cuota antigua no justifica saltar pruebas ni reconstruir un paquete fuera de CI.

Fuentes: [límites de releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), [API de releases](https://docs.github.com/en/rest/releases/releases).
