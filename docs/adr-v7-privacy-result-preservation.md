# D18 — Preservación transaccional de resultados

12-oct-2026. Decisión previa a034; no autoriza una purga por sí sola.

La preparación de resultados parte del job031 y de sus fuentes nativas bajo
la lease030. No acepta del cliente listas de intentos IA, saldos ni indicadores
de conservación. Recolecta la proyección completa del perfil en la misma
instantánea y verifica su reconstrucción antes de modificar fuentes.

Un recorrido con historia financiera comercial captura024 y mantiene sus fuentes
mutables durante la retención financiera. Así una corrección032 sigue ajustando
ingresos sin recuperar contenido. Un recorrido sin ese propósito sella COHORT,
FINANCIAL e intentos IA operativos ya terminales: sólo conserva los agregados y
la deduplicación técnica. Un intento reservado, en vuelo o incierto bloquea.

El sello IA guarda identidad técnica y hash de su ledger inmutable, sin facts,
contenido, prompts ni personas. El lector omite esa fuente únicamente cuando
la conversación es un stub de borrado y el sello y ledger coinciden. Esto evita
reclasificar como gasto sin atribución una fuente ya incorporada al agregado.
Sin stub sigue leyendo la fuente normalmente; una divergencia no se oculta.

Después de la minimización, el ensamblador debe reconciliar fuentes y comprobar
igualdad exacta de todos los granos, monedas, contadores e histogramas. Cualquier
diferencia revierte la transacción entera. El cierre nativo restaura READY sólo
si coinciden job, lease, backend, transacción, generación, watermark, instante de
finalización y hash de los agregados capturados antes del sellado. No crea una
segunda generación ni una nueva fecha de observación dentro de la misma RR.
La lectura pública posterior al COMMIT forma parte de la prueba de aceptación.
Este puerto no recibe callbacks de
red ni ejecuta033, archivos o copias: el ensamblado final debe autenticarlos antes
de conceder autoridad. Ni un sello de resultados ni el estado INVENTORIED son
un recibo de borrado completo.
