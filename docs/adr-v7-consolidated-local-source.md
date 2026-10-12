# ADR — Fuente privada consolidada antes del siguiente candidato V7

Fecha: 2026-10-12. Estado: preparación local autorizada; sin publicación ni migración.

## Contexto

El candidato público 51f72 permanece inmutable y su FULL terminó fallido. Las
funciones F2/F3/F4 existen en ramas con bases compartidas y partes pendientes de
montaje. F5–F7 requieren adaptación adicional. Gastar otro FULL en un incremento
intermedio no acredita el conjunto solicitado. Los gates por fase, la identidad
SHA probado/empaquetado/instalado y las condiciones temporales F8/F9 permanecen.

## Decisión

Crear una rama privada aislada desde 7be4033 (tooling revisado y dos fixtures de
CI corregidos), incorporar el incremento portable de paginación 20058709 y el
paquete F2 d9f73462. Conservar el historial de ambos e inspeccionar sus conflictos.
No tomar los commits administrativos de recuperación DISPATCH posteriores a esa
base. No se exporta este árbol entero por inferencia: los filtros, privacidad,
manifest e import closure se vuelven a comprobar cuando exista candidato final.

F3 comparte F2 hasta 93141f90 y F4 hasta d75310e5. Sus cambios propios y futuros
commits se integrarán una vez revisados, conservando las migraciones aditivas
008/009/010/011 y las 68 migraciones históricas inmutables. Ningún dirty tree de
otro dueño se copia o modifica implícitamente. La rama original del núcleo de variantes contiene RF14, pero el commit
5003a638 de persistencia es sólo el delta de motor (7 rutas). Se incorporará
f80fa255 de RF14 explícitamente, seguido de 5003a638 y d01d72d7, sin copiar
la base F2 antigua ni omitir el paquete AI.

El montaje deberá verificar la autoridad de perfil en API/MCP/web/worker y sus
consumidores reales, no sólo handlers aislados. Se mantiene una matriz explícita
de implementación, prueba, instalación y operación para todas las fases. No se
introducen banderas para presentar funciones incompletas como cerradas.

## Validación y límites

Cada incorporación conserva su peer y pruebas anteriores como evidencia
histórica; el árbol compuesto requiere sus propias pruebas proporcionales y un
FULL local con 21 etapas antes de proponer el siguiente evento nativo. Aislar las
integraciones que instalan transiciones de perfil es un requisito del conjunto.
No se disminuyen suites, aserciones, presupuesto ni rechazo de fuente sucia.

F8 exige siete días sanos antes del retiro, y F9 mantiene sus ventanas reales de
observación. Un cambio posterior de código exige nuevamente sus gates y una
admisión económica vigente. Esta consolidación no afirma que dichas condiciones
puedan acreditarse con una sola ejecución ni que las fases estén completas.
