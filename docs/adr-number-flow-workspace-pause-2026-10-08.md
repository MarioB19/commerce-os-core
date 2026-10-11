# Laboratorio de números con ventas pausadas

La pausa de workspace se guarda en `manual_controls` sin entorno. El laboratorio
de números copia sus recursos a SIMULATION dentro del mismo workspace, por lo
que la pausa impedía avanzar y despachar incluso con el transporte aislado.
Retirar esa pausa para ensayar también quitaría una barrera REAL.

La excepción se limita al bit `paused` del control del workspace durante un
ensayo de números explícito. Automation y channel comprueban el mismo grafo
persistido: conversación/contacto/cuenta/simulación SIMULATION del mismo
workspace, contacto `opaque:sim-<test>`, cuenta simulator con `lab_snapshot`,
`ISOLATED_SIMULATOR` y envío real deshabilitado, simulación NUMBER_FLOW_TEST_V1
RUNNING/COMPLETED con aislamiento sin red ni efectos externos y evento inmutable
`number.flow_test_started` de la API para esa simulación y cuenta fuente.
Marcadores sueltos, referencias cruzadas, pruebas RESET o simulaciones genéricas
no conceden la excepción. Los ensayos ya creados por la API conservan su
procedencia y no requieren duplicarse.

La evaluación proyecta el control sin escribirlo. `takeover` y `suppressed` del
workspace conservan su efecto, al igual que todas las pausas de cuenta,
workflow, conversación y contacto. SIMULATION genérica y warm-up mantienen la
pausa global. No cambia el endpoint de controles, la política REAL, los permisos,
ownership, cuotas ni la selección de proveedor. Channel vuelve a evaluar el
grafo y los controles en su gate antes del envío; el proveedor simulator conserva
su comprobación transaccional y nunca recibe credenciales de WhatsApp.

Validación requerida: recorrer la API real del laboratorio hasta un efecto
sintético confirmado manteniendo byte a byte la pausa y política REAL; rechazar
marcadores falsos, grafo cruzado, proveedor externo, estado RESET, ausencia de
evento de creación, otras pausas y takeover/suppressed globales. Conservar las
pruebas de idempotencia y ausencia de efectos REAL del laboratorio existente.
Esta decisión no acredita publicación, ensayo instalado ni recepción física.
