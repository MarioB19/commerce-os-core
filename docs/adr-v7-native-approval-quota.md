# Ventana de cuota antes de la barrera final de aprobación

Fecha: 6-nov-2026. Alcance: controlador de publicación; aplicación sin cambios.

El FULL `91c69bac-c937-4640-b456-39f1b4a21839` de `01aab61` pasó las 21 etapas.
La aprobación posterior recibió HTTP429 aun sin sondeos externos. Monitoring
identificó `AllElseRequestsPerMinutePerProject`; el build siguió PENDING y no
ejecutó. Google Cloud mantuvo 60 solicitudes/minuto al solicitar 120. La cuota
comparte las listas regionales y la aprobación; espaciar lecturas a 1.25 segundos
no bastó para dos inventarios consecutivos y el POST inmediato.

El controlador espera 65 segundos desde su última lectura Cloud Build antes de
la barrera final de aprobación. Esa barrera vuelve a leer control, custodia,
ledger, autorización, vigencias, GitHub e inventario completo. El POST sigue
inmediatamente después, sin otra pausa. No cambia el máximo de 120 segundos de
vigencia de elegibilidad, el inventario de 90 segundos, ni el request de 450
segundos. La espera usa reloj monótono y tolera despertares anticipados.

La pausa no reintenta una operación incierta ni permite reutilizar el gate.
El intento rechazado se concilia con evidencia y conserva su cargo. CreateBuild
mantiene su comportamiento. Las pruebas cubren separación de inventarios,
despertar anticipado y rechazo si permisos, vigencia o inventario cambian durante
la pausa. El candidato nuevo requiere FULL nativo y atestación propios.

La proyección conserva los respaldos y US$150 brutos. Reemplazar las reservas de
dos FULL terminados por sus duraciones nativas, redondeadas hacia arriba, permite
reservar este FULL adicional y su control: estimación US$149.76, admitida en
US$150. No se reduce retrospectivamente el cargo de los intentos rechazados.
