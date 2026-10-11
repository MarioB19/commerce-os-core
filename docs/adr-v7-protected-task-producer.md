# Productor de tareas protegidas del control plane

2026-10-11. El operador prepara tareas deterministas a partir de fuente revisada,
admisión económica adoptada e inventario nativo completo. El productor es puro:
no obtiene credenciales, escribe custodia, inicia builds ni declara evidencia
nativa. El operador autentica los inputs antes de usarlo y publica el resultado
mediante la custodia CAS existente; HTTP no admite estos documentos del usuario.

SOURCE y FULL comparten intento, plan y autorización. El plan sella la plantilla
FULL de 95 minutos antes de adquirir el archivo; la generación y hash reales del
archivo se añaden únicamente a la propuesta después de la lectura GCS. No se
inventa una generación ni un UUID de Build. Cada fase conserva identidad, hashes
y expiración, limitada a cuatro horas y nunca más larga que sus autorizaciones.

La atestación usa otro intento y dos minutos reservados. Su contrato procede de
un Build nativo pendiente y exige el FULL exitoso conciliado del mismo SHA/árbol.
PR y main usan eventos y fuentes propios: el merge no transfiere un PASS anterior.
Los controles iniciales quedan pausados y sin tarea. Cambiar de fase requiere
custodia nueva y CAS sobre el control, sin borrar intención ni renovar un intento
incierto. Los lectores y fences del runtime revalidan nuevamente al ejecutar.
