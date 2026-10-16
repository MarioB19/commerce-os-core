# V7 F2 — alta exclusivamente por invitación

Decisión del 11-oct-2026, antes de implementar. Continúa
[el contrato de invitaciones](adr-v7-profile-invitations.md). El alta pública de
Better Auth permanece deshabilitada. Esta frontera admite únicamente un enlace
vigente emitido para un perfil ACTIVE por un Dueño que conserva su autoridad.

La persona introduce nombre, correo y contraseña junto con el enlace. El correo
normalizado debe coincidir con el destinatario cifrado y su HMAC; no selecciona
perfil ni rol. Un correo con identidad existente exige iniciar sesión y usar la
aceptación ya preparada: el alta nunca sustituye credenciales ni reactiva
identidades o membresías. El enlace demuestra acceso al correo invitado; sólo
tras comprobarlo se registra esa identidad con correo verificado.

Se reutilizan `hashPassword` de Better Auth y sus límites configurados de
12–128 caracteres. La identidad y cuenta `credential`/`local:credential`
conservan el mismo formato nativo utilizado por la provisión existente. Una
transacción única crea usuario, credencial, membresía del rol invitado,
aceptación y auditoría. Los locks administrativos preceden a filas de perfil,
invitación y Dueño; se revalida reloj después de las esperas y antes de COMMIT.
Una restricción única de correo resuelve carreras entre perfiles sin cambiar
la identidad ganadora. Todo fallo revierte el conjunto.

La guarda SQL distinguirá explícitamente alta de identidad existente. La rama
de alta exige que usuario, cuenta credential y membresía exacta se hayan creado
en la misma transacción, además del enlace y contexto del perfil. No se fabrica
una sesión para superar la aceptación existente. Esta frontera sigue siendo
parte de la transición aislada y de la revisión pendiente de privilegios/RLS.

El endpoint exige Origin confiable, cuerpo cerrado/acotado y ausencia de PAT,
selectores de perfil y sesión interactiva. Las cuotas persistentes de identidad
por IP y enlace se consumen antes del hash costoso. Ninguna respuesta, log ni
evento contiene enlace, contraseña, correo o hash de credencial. No se emite
cookie, token de sesión ni se selecciona perfil; la persona entra después por
el login nativo. Una respuesta perdida no habilita reintentos automáticos: la
pantalla dirige al login y a la consulta autenticada del enlace, que confirma la
aceptación histórica sin crear otra membresía.

Este documento no acredita implementación, publicación, correo enviado ni alta
real. No se registra la ruta ni se aplica una migración productiva en esta fase.
