# Commerce OS — Desarrollo y publicaciones

## Contexto al empezar

- Lee `docs/PROGRESS.md` para conocer lo implementado y lo pendiente.
- Para introducir o publicar cambios, lee `docs/publishing-changes.md` y `docs/ci-cd.md`. El pipeline existente ya fue validado en producción; su evidencia está en `docs/evidence/ci-cd-production-validation.json`.
- Si trabajas dentro del vault de Commerce OS, aplica también su `AGENTS.md` y consulta `🛒 Commerce OS — Índice.md` en la carpeta superior. Ventas es un módulo de Commerce OS y WhatsApp un canal.

## Trabajo y entrega

1. Revisa rama, estado y cambios existentes. Conserva trabajo ajeno; usa una rama propia del agente (`codex/...` o `claude/...`) y una carpeta de trabajo independiente cuando haya tareas concurrentes. Nunca modifiques ramas ni carpetas de otro agente.
2. Implementa con pruebas proporcionales al riesgo. La secuencia exacta de CI está en `.github/workflows/ci.yml`; los comandos locales y sus dependencias están en la guía.
3. Añade migraciones nuevas; no edites ni elimines migraciones aplicadas. El instalador valida su historial por nombre y hash.
4. Con publicación autorizada, integra el cambio revisado en `main` y utiliza el CI/CD existente. La construcción productiva, IAP, respaldo e instalación ya están automatizados. Cloud Shell y `setup-ci-identity.py` son para configuración inicial o diagnóstico, no para cada release.
5. Sigue el run del SHA correcto hasta su resultado. Un check verde de una rama o un `deploy` omitido no acredita instalación. Para una entrega de aplicación, verifica el informe `SUCCEEDED`, el SHA y el recorrido afectado en producción.
6. Documenta cambio, validación, run y límites en `docs/PROGRESS.md`; guarda sólo evidencia sanitizada en `docs/evidence/`. Actualiza el índice del vault cuando esté disponible y corresponda.

## Contrato operativo del despliegue

- Los pushes de aplicación a `main` despliegan después de las pruebas. Las otras ramas y PR sólo verifican. Los cambios exclusivamente documentales omiten despliegue cuando no hay aplicación pendiente desde la última publicación exitosa.
- No uses `[skip ci]` para aplicación. Un cierre sólo documental puede omitir CI tras comprobar que no deja una versión de aplicación pendiente.
- Si `main` avanzó, sigue su run vigente; no insistas en desplegar un SHA superado. Antes de reintentar un fallo de transporte, comprueba que el instalador remoto no sigue activo.
- Mientras instala, el instalador retiene REAL. Desde V7 (D-01, ADR-V7-03) una publicación no crea, renueva ni revoca autorizaciones comerciales: al terminar sólo se reanudan las asignaciones humanas vigentes y lo que venció durante la retención se cancela con registro, sin enviarse. Un agente nunca crea, amplía ni reactiva una asignación por inferencia; cada asignación nueva requiere la intención específica de una persona (Brandon o la persona Dueño del perfil). El despliegue no envía outbound ni modifica gasto publicitario.
- Credenciales, sesiones, tokens, llaves, teléfonos completos y datos de clientes permanecen fuera de Git y notas. La configuración de GitHub usa identidad temporal OIDC; no necesita una llave persistente de cuenta de servicio.
