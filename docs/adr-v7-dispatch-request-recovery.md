# Recuperación de solicitud DISPATCH con Build identificado — 2026-10-11

El intento público 0bfc768b conservó UNKNOWN después de CREATE. Un original regional auténtico acredita que el Build 1b64eda8 existe. No se conserva la respuesta inicial del transporte: no se atribuye el fallo a una carrera, una latencia o un campo ausente.

La recuperación autenticará el POST terminado, la pausa de control, el margen completo de 450+30 segundos, las tres lecturas de ledger/metro/control y el Build único con fuente, configuración, intención y procedencia exactas. La evolución del ledger desde RESERVED debe reproducir únicamente submit_intent y unknown canónicos; ninguna otra fila puede cambiar. La evidencia es fresca por 120 segundos y debe autenticarse nuevamente inmediatamente antes de una sola CAS del metro.

El metro conserva íntegros techos, filas, meses y consumo; sólo completa la solicitud exacta y libera active_request. Ledger permanece UNKNOWN, con 95 minutos reservados. No se autoriza CREATE ni éxito. Una nueva tarea RECONCILE_FULL canónica podrá ligar el UUID existente y observar su estado. La incertidumbre del CAS exige sólo relectura exacta, nunca repetición automática.

Este parser pertenece al perfil público fijo. El adaptador administrativo carga los validadores públicos sellados de la imagen que ejecutó DISPATCH, junto con el parser nuevo pinneado. No modifica el candidato b170 ni las imágenes y no acepta selección de perfil desde solicitudes HTTP.
