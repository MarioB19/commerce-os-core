# Variantes de mercado y selección determinista

Decisión previa al código, 12 de octubre de 2026. Incremento privado F4;
RF-05.a/b, RF-06.f y base de RF-19.b/f/j. No modifica el candidato F0 51f72.

El enrutador V5 resuelve productos y asignaciones en `commercial-assignments`.
Ya protege respuestas conocidas, señales de pago, conflictos e historia. No se
reemplazará durante la preparación V7: faltan persistencia de variantes y el
contexto transaccional F2. Este incremento añade contratos cerrados y un motor
puro para variantes; el montaje posterior debe reutilizarlo tanto en REAL como
en laboratorio, conservando las protecciones del enrutador existente.

Una familia y cada variante pertenecen al workspace/perfil y entorno. El ID de
perfil es el workspace existente (cadena de 1–256 caracteres sin NUL); no se
crea otra identidad global. Una versión comercial inmutable fija mercado,
moneda ISO, idioma BCP47, zona IANA, precio en unidades menores y referencias
exactas de oferta, flujo, vendedor, cobro, remarketing y materiales. Ningún cambio
de moneda convierte importes anteriores. Los lectores futuros deben autenticar
las referencias en la misma transacción de perfil y comprobar su propiedad;
validar un JSON o una suma hash no equivale a esa autoridad.

La copia a otro mercado crea exclusivamente un borrador independiente. Requiere
IDs nuevos del servidor, conserva referencias a versiones inmutables como base
de edición y exige revisar idioma, precio/moneda, cobro, flujo/vendedor,
remarketing y materiales. No copia números, campañas, credenciales ni permisos.
Ni copiar ni resolver una ruta habilita envío o publicación.
Los valores devueltos son copias independientes. La inmutabilidad de versiones
y snapshots persistidos requiere el repositorio transaccional aún pendiente;
este motor puro no impone un bloqueo de escritura en base de datos.

La resolución recibe una proyección interna acotada y ya autorizada del chat.
No es un schema de petición HTTP ni acepta `verified: true` del cliente. Orden:
recorrido abierto fijado; origen publicitario observado y ligado a asignación
vigente; selección explícita autenticada; variante única elegible; elección.
Una referencia de campaña vieja o una selección vencida no cae silenciosamente
en la variante única. Evidencias contradictorias del mismo nivel exigen elección.
Los orígenes pertenecen sólo al evento actual: una nueva selección explícita
se evalúa con su propio evento, sin arrastrar indefinidamente el origen obsoleto.
Las pausas/protecciones actuales dominan cualquier ruta. Un recorrido existente
conserva su snapshot completo aun cuando cambien las versiones vigentes; una
variante sin asignación vigente no inicia un recorrido nuevo. El resultado
incluye razón y referencias de evidencia, nunca atribución de campaña inferida.

La función es común a REAL/SIMULATION: el entorno sólo participa en el alcance.
Las pruebas comparan decisiones e identidades entre ambos entornos con datos
sintéticos; eso no acredita el montaje del motor en worker/emulador ni ausencia
de efectos reales en producción. No hay SQL, red, proveedor, secreto o reloj
global en este incremento.

Gates de integración: migración aditiva/FK/RLS y mapa producto→México, revisión
transaccional F2/autoridad de asignación F3, publicación por CAS, API/MCP/Web de
cinco secciones y equivalencia con historias V5, captura de snapshot persistente
y revalidación antes de cada efecto. La activación requiere sus pruebas nativas
con roles restringidos y el CI/publicación canónicos; no se omite ninguno.
