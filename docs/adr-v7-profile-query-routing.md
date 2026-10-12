# ADR — Consulta heredada dentro de autoridad de perfil

Fecha: 2026-10-12. Estado: núcleo local preparado; montaje HTTP/worker pendiente.

La aplicación V1 aún selecciona la primera membresía y trata el PAT como Dueño.
Montar un selector V2 sin sustituir ese contexto dejaría dos autoridades distintas.
Los módulos de perfil ya ofrecen transacciones con autoridad vigente bloqueada,
revalidación posterior y un ejecutor de perfil inmutable.

Se añade un contexto asíncrono de consultas que **sólo el código servidor** abre
con ese ejecutor dentro de la transacción de autoridad. El pool compartido dirige
sus consultas al ejecutor vigente; una referencia al método capturada antes del
contexto no elude la dirección. Las llamadas a `withTransaction` se unen a la
transacción existente sin abrir ni confirmar otra. Una transacción de perfil
anidada exige el mismo perfil. No se entrega conexión ni se permite `pool.connect`
o administración del pool dentro del contexto. Uso tardío o intento de escapar
invalida el contexto; nunca cae al pool global ni se convierte en éxito aunque el
consumidor capture la excepción. Dos solicitudes concurrentes no comparten estado.

Este adaptador no autentica, no decide permisos ni valida SQL arbitrario. Los
consumidores siguen siendo código confiable, con parámetros SQL; la autoridad y
RLS corresponden a los puertos de sesión/PAT y al rol SQL restringido. Los sitios
que cambian aislamiento, usan conexión/locks de sesión, acceden a identidad global,
archivos o efectúan I/O externo requieren adaptación explícita. El inventario debe
cerrar esos sitios antes del montaje: no se sustituye su protocolo PREPARE/efecto/
RECONCILE por una transacción HTTP larga.

No se cambia `createApp`, las rutas V1 ni workers en este incremento. El montaje
posterior debe declarar acción y entorno por ruta, establecer identidad sin
fallback, envolver el handler autorizado y entregar la respuesta sólo después del
COMMIT. Ninguna función se considera montada ni publicada por este núcleo.

## Respuesta materializada

El adaptador HTTP nuevo recibe una acción fija por ruta, resuelve la identidad
mediante el puerto V2 y abre el contexto SQL únicamente dentro de su callback.
Un vínculo de Principal construido desde esa autoridad se retira en `finally`.
Los métodos permitidos de respuesta preparan estado, cabeceras y contenido en
memoria; la respuesta real se envía después de la revalidación final y COMMIT.
No expone `raw`, `hijack`, streams ni métodos desconocidos. El contenido se copia
antes de cerrar la transacción para que una mutación posterior no cambie lo
autorizado. Errores de protocolo invalidan el resultado aun si el handler los
captura. Las rutas con streaming/archivos grandes o efectos remotos requieren su
adaptador propio y no se montan automáticamente mediante este wrapper.

El binder se ejecuta dentro de ALS y recibe su ejecutor exacto; no se acepta un
Principal previo. El montaje SQL no admite serializers ni esquemas de respuesta
particulares que puedan fallar después de confirmar; requieren materialización
previa equivalente. El cuerpo y Content-Type también se validan antes de COMMIT.
