# Inteligencia y Estudio V1 · ficha de regreso

Estado al 08-sep-2026: V1 técnica publicada y comprobada; Worker 0.1.1 y MCP instalados en el Mac, respaldo final recuperado y distribución privada publicada. La revisión editorial humana permanece pendiente.

## Cómo empezar

1. Entrar a [Commerce OS](https://commerce-os.inovaris.online) con la cuenta habitual.
2. En [Inteligencia](https://commerce-os.inovaris.online/intelligence), consultar las búsquedas guardadas de Brasil y México. Leer el cache no consume proveedor; actualizar sí requiere presupuesto.
3. Abrir [Estudio](https://commerce-os.inovaris.online/studio) para revisar los dos proyectos piloto y sus archivos. Los enlaces siguientes requieren autenticación y permisos; no contienen acceso firmado a R2.
4. Para un render nuevo, abrir Commerce Worker en el Mac y pulsar **Iniciar**, con corriente. La app y sus datos están en el SSD interno; KINGSTON no es una dependencia configurada del worker. Cerrar sólo la ventana conserva el trabajo. Usar **Detener al terminar** en la ventana o **Salir al terminar el trabajo** en la bandeja para detenerlo. Se entrega detenido después del piloto.
5. MCP está configurado como `commerce_os` en Codex, actualizado a `362afed1`, con un token del propietario y cinco scopes. Las consultas reales conservan IDs, evidencias y análisis dentro del límite de respuesta. Usa la misma API; no necesita ejecutar el motor para buscar o consultar trabajos. [Configuración y operación](commerce-worker.md).

| Creativo propio | Producción nueva | Resultado |
|---|---|---|
| Mi Ciclo Listo — Preescolar | Mac Apple Silicon; 1080×1920, 30 fps, 42.2 s | [Revisar master](https://commerce-os.inovaris.online/studio/review/7feed4ca-ac74-42c6-b361-18aa58d99155), SHA `3ae3f5dfcfdf0066954fe4deb30b0b63e46440b1bbdabe56a377f1f5af537544` |
| 100 Oraciones por Mis Hijos | Windows x64 instalado en CI nativo; 1080×1920, 30 fps, 30.5 s | [Revisar master](https://commerce-os.inovaris.online/studio/review/ceefcf5c-f7d1-473e-971d-129d2517dd28), SHA `6c87d9fd0c1c5b6b584eee571e522564317d8df40058b5a43144c09d235bdca9` |

Cada trabajo incluye master, preview 540p, captions, copy y manifest. Los doce controles técnicos pasaron, ambos masters se generaron de nuevo y las descargas de R2 coinciden con sus SHA. Se conservan voz/copy/escenas aprobados de las recetas v1; las dos voces nuevas de ElevenLabs tienen propuestas v3 separadas, aún sin aprobación. [Evidencia de los trabajos](evidence/creative-v1/published-operational-jobs.json).

## Versiones y respaldo

Web/API: `362afed1b89abb92b3cf4c3b98df80195c82555e`, [CI publicado y verificado](https://github.com/MarioB19/commerce-os/actions/runs/34274395762). Worker 0.1.1 y MCP proceden de ese mismo commit; motor 1.0.0, Remotion 4.0.503 y Node 24.20.0. [Instaladores y MCP privados para ambos sistemas](https://github.com/MarioB19/commerce-os/releases/tag/creative-worker-v0.1.1-362afed1): 14 archivos publicados y verificados; acceso mediante la cuenta autorizada del repositorio. [Integridad y procedencia](evidence/creative-v1/private-release-published-362afed1.json).

El respaldo final conserva cuatro proyectos, 59 objetos de la biblioteca y sus metadatos/journal: 65 entradas y 471.626.058 bytes. Se verificó del SSD interno a una restauración nueva en KINGSTON, con hashes y permisos exactos, incluyendo los cuatro trabajos y veinte artefactos. El respaldo anterior permanece. No es una copia en otra ubicación geográfica. [Ubicaciones y restauración](commerce-worker-library-backup.md).

## Qué se comprobó y qué significa

Cuatro búsquedas BR/MX produjeron 146 observaciones con cobertura parcial y veinte análisis de texto. Las señales de anuncios no demuestran ventas; no se analizó audio/video que no se hubiera obtenido. La investigación de primaria y el material creativo Preescolar se mantienen separados.

Windows comenzó a descargar y producir desde R2 con el Mac pausado. Después hubo dos renders simultáneos, con un proceso pesado por equipo y sin motor de render en el VPS. Las consultas comerciales dieron 40/40 HTTP 200 en cada fase: p95 inicial 161.515 ms, durante 90.623 ms y posterior 88.738 ms. [Método y límites](intelligence-commercial-latency.md).

La reutilización también quedó comprobada en el Worker 0.1.1: un clon de prueba de Oraciones generó el vídeo base en 279.290 segundos; cambiar sólo el formato del texto publicitario tomó 22.720 segundos. Master, preview y captions conservaron sus hashes, con nuevos copy y manifiesto y cero llamadas de proveedores. Son tiempos de esta prueba, no una garantía para cualquier receta. [Evidencia de reutilización](evidence/creative-v1/published-render-reuse-362afed1.json).

## Costes y vigencias

- **Remotion: USD 0.** Con la declaración de dos personas quedó `FREE_ELIGIBLE`, habilitado y sin caducidad artificial. La opción pagada se descartó sin compra ni cobro. Reconsiderar sólo si cambia la elegibilidad del equipo. [Licencia4.0.503](https://github.com/remotion-dev/remotion/blob/v4.0.503/LICENSE.md).
- **Workers Paid: USD 5/mes**, siguiente periodo 08-oct-2026. Disco VPS: incremento aproximado USD 0.40/mes antes de impuestos. R2: consumo aplicable dentro de los límites del piloto.
- OpenAI contabilizó **USD 0.086581** por veinte análisis. SearchAPI conserva **USD 0.028 estimados** y ElevenLabs **USD 0.4023 estimados** reservados, sin cargo monetario confirmado; no se presentan como gratuitos ni como factura liquidada.
- Token MCP del propietario: vence 08-oct-2026. Cuentas técnicas temporales: expiran 09-sep-2026; las cuentas habituales permanecen. Credencial de R2: rotar antes 08-mar-2027. No hay claves de proveedores en el worker.

[Ficha completa de límites y costes](creative-pilot-costs.md) · [Matriz por criterio](creative-v1-acceptance.md) · [Progreso y publicación exacta](PROGRESS.md).

## Pendientes externos

La revisión audiovisual/editorial final corresponde a Brandon. No se aprobaron anuncios ni se habilitaron campañas o mensajes reales. La instalación en el Windows personal del compañero requiere ese equipo y su sesión: el instalador y los renders de Windows CI acreditan ese entorno, no su experiencia personal. Los manifiestos y recursos tienen firma interna de integridad. En Mac la apertura normal y el diagnóstico pasaron; el paquete no tiene firma válida de distribución de macOS (su comprobación estricta falla), ni notarización. Los certificados de distribución del sistema operativo siguen fuera de los accesos disponibles. No se desactivaron protecciones del sistema.
