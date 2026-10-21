# Identidad del dueño en la publicación V7: versión de los tokens (Agente: Claude)

21-oct-2026. La ventana de instalación de `36231cb1`
(`cv-7f04216a-…-1`) exportó, migró a 117 y levantó los seis servicios sanos
(incluido `channel-worker`, ya corregido). Se detuvo al final, en
`commit_stage`, con `COPY_OWNER_AUTH_IDENTITY_CHANGED`. Producción regresó al
snapshot frío `commerce-os-test-boot-v7-cold-20261021c`.

## Causa

`compare_owner_auth` compara la identidad del dueño antes y después de la
publicación: sesiones (`id`, usuario, alta), membresías de dueño y cada token
personal vigente con todos sus campos, incluida `version`.

La migración 0072 agrega `profile_scopes` y asigna los alcances cerrados de
perfil a cada token que no los tenía (todos, en V5). El trigger
`guard_personal_profile_token_identity` sube la `version` del token en uno
cuando cambian sus alcances. No cambia el token, su dueño, sus entornos, su
vigencia ni su revocación, pero la comparación histórica lo trata como un
cambio de identidad. Las pruebas sintéticas no lo cubrían porque simulan la
comparación.

## Decisión

Sólo en la publicación V7 de perfiles (`is_v7_profile_publication`, 68→117),
`stage_continuity` compara con `v7_profile_owner_auth`:

- exige exactamente los mismos tokens (mismos `id`, ni uno más ni uno menos);
- exige que cada token tenga `version` = la previa + 1 (el único cambio de
  0072); cualquier otra diferencia de versión es
  `COPY_RUNTIME_V7_TOKEN_VERSION_UNEXPLAINED`;
- proyecta la observación posterior sobre las versiones previas y ejecuta la
  comparación histórica sin cambios (sesiones, membresías, entornos, alta,
  vigencia, revocación).

Cualquier otra publicación conserva la comparación histórica, donde un cambio de
versión sigue siendo un cambio de identidad.

## Consecuencias

- La publicación V7 puede terminar `commit_stage` sin relajar el resto de la
  comparación del dueño.
- Pruebas: la comparación histórica rechaza el +1 y la de V7 lo acepta; la de
  V7 rechaza versión igual, +2, booleana, tokens nuevos o faltantes, cambio de
  entornos, revocación, vigencia, sesión nueva y rol; `stage_continuity` sólo
  usa la proyección cuando la llamada lo pide explícitamente.
