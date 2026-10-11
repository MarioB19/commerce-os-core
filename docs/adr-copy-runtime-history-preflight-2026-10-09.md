# Comprobar el historial de propiedad antes de publicar

En el intento37893296316-1, el primer upgrade OPERATING de la copia aplicó0068 y activó los ocho servicios, pero el directorio privado ownership-attestations no existía. El helper de atestación rechazó el almacenamiento después de activar; el publicador conservó el hold y reportó que necesita conciliación durable. Ese fallo original no acredita una publicación completa.

El publicador debe crear su directorio de historial protegido antes de prepare, captura de ownership, hold, migración y activación. Debe aceptar un directorio existente sólo si es privado y pertenece a la identidad Root del controlador. Rechaza enlaces, archivos, permisos abiertos y propietarios distintos; no corrige permisos ajenos ni cambia pruebas existentes. El descriptor de su padre privado impide seguir un enlace al crear o abrir el nombre fijo.

Este prerrequisito no libera hold, no atestigua números y no recupera retrospectivamente un intento fallido. La conciliación de b12f necesita su revisión separada, archivos originales preservados y cierre verificado Root/B02. Las pruebas deben reproducir el directorio ausente, conservar pruebas existentes y rechazar estados inseguros antes de ejecutar prepare.
