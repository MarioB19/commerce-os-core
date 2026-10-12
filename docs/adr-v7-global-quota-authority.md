# V7 — Autoridad cerrada para cuotas globales

Fecha: 2026-10-12. Estado: componente local preparado; sin adopción nativa.

Las cuatro funciones de 014 necesitan contar todos los perfiles y su historial
para conservar los límites de 3 perfiles, 20 números y 300 conversaciones por
día. Aplicarles la misma visibilidad que a una petición de un perfil ocultaría
consumo y cobertura ajenos. El límite LOAD1000 sigue exigiendo su admisión exacta.

Un nuevo propietario NOLOGIN, NOINHERIT y NOBYPASSRLS recibe únicamente las cuatro
funciones auténticas, con sus cuerpos, relojes y locks intactos. Puede leer las
tablas pequeñas de política/cobertura/consumo global; sólo puede insertar cobertura
y consumo o retirar una reserva mediante la columna prevista. La lectura de
registros, controles y operaciones queda limitada al perfil transaccional y a
REAL. Ningún cuerpo, secreto ni consulta global se devuelve al runtime.

Antes de crear el rol se comprueban definiciones y ACL de las funciones; un rol
preexistente, permiso extra o cuerpo cambiado aborta la transacción. Las funciones
de inventario/adopción conservan acceso exclusivo del propietario de migración;
no se conceden al API ni workers. Los triggers no otorgan acceso directo a cuotas.
La identidad de las cuatro funciones y todas las filas se conservan.

El corte general debe conservar estas políticas específicas del propietario y
aplicar sus barreras de runtime a roles explícitos. No puede añadir una política
restrictiva PUBLIC que oculte otros perfiles a este contador. Esa obligación se
prueba con RLS forzada y consumo de un segundo perfil; no se supone satisfecha
por la mera transferencia de funciones. Este componente no monta consumidores,
no crea políticas económicas ni adopta perfiles o inventarios reales.
