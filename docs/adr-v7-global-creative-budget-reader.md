# V7 — Contadores del presupuesto creativo compartido

Fecha: 2026-10-12. Estado: componente preparado, sin instalación nativa.

`creative_global_budgets` es un techo por perfil compartido entre REAL y
SIMULATION. Las reservas, consumos y operaciones de coste desconocido de ambos
entornos deben seguir contando después de habilitar RLS en las tablas hijas.
No se duplican límites ni se descuenta un entorno del agregado.

El puerto fijo `read_profile_global_budget` exige el perfil transaccional y un
entorno válido, adquiere el mutex existente `creative-provider:<perfil>` y
devuelve exclusivamente contadores, estado de caducidad y versión. El dueño
NOLOGIN/NOINHERIT/NOBYPASSRLS tiene SELECT de columnas cerradas de cuatro tablas;
sus políticas leen ambos entornos sólo del perfil actual. No puede leer cuerpos,
configuración, respuestas, credenciales, fuentes de autorización ni otro perfil.
Sólo API y automation pueden ejecutar el puerto; no pueden asumir ese rol.

En un ProfileExecutor auténtico, `readGlobalBudget` usa obligatoriamente ese
puerto y nunca vuelve al agregado antiguo ante un error. WorkerScope abre una
única fase para una lectura de estado; la admisión exige una fase ya abierta
para mantener el lock y la posterior reserva en la misma transacción. Fuera de
los boundaries V7 el camino histórico conserva su comportamiento durante la
preparación. El montaje final debe garantizar que ningún consumidor publicado
quede fuera de esos boundaries; este incremento no acredita ese montaje.

Los resultados no modifican reservas, precios, límites ni decisiones existentes.
UNKNOWN sigue retenido y visible; la autorización de gasto y los periodos
conservan los bloqueos deterministas anteriores. La prueba PostgreSQL fuerza
RLS por entorno para el runtime y verifica que el contador cerrado aún suma
ambos, junto con aislamiento entre perfiles, ACL, caducidad y serialización.
