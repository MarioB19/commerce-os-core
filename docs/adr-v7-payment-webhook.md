# ADR V7 — Webhook de pago opcional (RF-08.e, D-05)

Agente: Claude · 14-oct-2026 · rama `claude/v7-f2-cutover`.

## Decisión

V7 cierra **sin webhook de pago**. El método por defecto es el comprobante
(SPEI o enlace de pago del proveedor que elija el negocio) revisado con las
reglas de comprobante de la variante (RF-09) y, cuando hace falta, por una
persona. Un webhook de proveedor no es requisito para cerrar V7 (D-05).

## Motivos

- **Alcance:** cada negocio usa su propio enlace (Whop, Hotmart, Stripe,
  Mercado Pago u otro, RF-08.b). Un webhook exige una integración y una
  credencial por proveedor y por negocio; no hay uno común.
- **Confiabilidad:** el comprobante funciona igual para SPEI y para enlaces,
  queda auditado (RF-09.e) y cubre el caso de ambos métodos sin duplicar pago
  (EMU-PAY-METHOD). Un webhook ausente o retrasado no debe bloquear la venta.
- **Costo:** sin servicios ni secretos adicionales dentro del techo de USD 100.

## Lo que la plataforma no afirma

Una captura o un comprobante aprobados **no** son verificación bancaria: la
aplicación los muestra como comprobante aprobado (por las reglas de la
variante o por una persona, con su motivo), nunca como pago conciliado con el
banco o el proveedor.

## Revisión futura

Si un negocio pide confirmación automática de un proveedor concreto, se
evalúa como integración por perfil (credencial propia, firma verificada,
idempotencia por evento) sin cambiar el camino por defecto.
