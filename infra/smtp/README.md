# SMTP de identidad — preparación, sin instalación

No se instala Postfix como parte del despliegue de aplicación. La VM actual no acreditó salida directa TCP25. Cambiar el puerto de escucha no resuelve ese impedimento. Un servidor de submission existente en 465/587 es compatible con el adaptador; debe ser elegido y configurado por el propietario.

`python3 scripts/diagnose-smtp-vps.py` ejecutado como root en la VM inspecciona presencia de servicios/configuración y conectividad sin AUTH/MAIL/RCPT/DATA. No imprime valores privados. [Operación completa](../../docs/account-security.md).

Si posteriormente se confirma salida directa y se autoriza instalación, `scripts/prepare-smtp-vps.py` renderiza en un directorio nuevo y privado:

- FQDN y dirección de escucha privados explícitos; cada cliente autorizado es una dirección /32. No se confía en la VPC ni en una subred Docker completa.
- Restricciones tanto de cliente como de relay y remitente; rechazo por defecto. No escucha en interfaces públicas ni recibe correo del dominio.
- Cola de máximo cinco minutos, límites de mensaje/conexión y DKIM requerido mediante milter; si DKIM no responde, el MTA rechaza temporalmente.

Ejemplo exclusivamente sintético, **no ejecutar para configurar la VM**:

```sh
python3 scripts/prepare-smtp-vps.py --hostname mail.example.invalid \
  --bind 172.30.0.1 --client 172.30.0.10 --sender security@example.invalid \
  --output /tmp/commerce-smtp-review
```

Antes de instalar: respaldar configuración existente, comprobar direccionamiento estable del único cliente API y que no colisione con redes actuales. El render no asigna IP ni altera Compose, Caddy, PostgreSQL o gateways. Instalar paquetes Postfix/OpenDKIM desde Ubuntu y aplicar los archivos sólo con autorización; `postmap /etc/postfix/commerce-senders`, `postfix check`, `postconf -n` y comprobación de listeners forman parte de esa instalación. Registrar prueba de rechazo desde un cliente ajeno antes de habilitar. La plantilla fue verificada como configuración preparada; no acredita un daemon instalado ni ensayo de relay en la VM.

OpenDKIM: clave generada y custodiada fuera del repositorio; selector acordado, `Domain`/`KeyFile`/`Selector` correspondientes, socket `inet:8891@localhost`, modo firma y clientes internos autorizados. No generar una clave de muestra que pueda confundirse con una real. Postfix debe firmar con el dominio alineado del remitente.

DNS pendiente de identidad elegida: A de FQDN hacia IP reservada, PTR hacia ese mismo FQDN, SPF único que conserve las fuentes actuales y autorice la IP de salida, DKIM TXT del selector generado, DMARC alineado. Conservar MX actuales y buzón de rebotes. No publicar registros de ejemplo ni duplicar SPF. El remitente debe ser un buzón/alias controlado; ni `security@` ni `no-reply@` se dan por existentes.

Protección: spool de Postfix con propietarios/permisos del paquete, disco privado y backups cifrados del host cuando se respalde. El spool contiene correo claro para root/Postfix: no tiene cifrado por mensaje. Los logs SMTP contienen direcciones, por lo que se mantienen privados, con retención limitada, sin copiar a notas/Git. No registrar cuerpos, URLs o credenciales. Los logs normales no incluyen el cuerpo del mensaje. No activar debug/verbose. Inspeccionar cola y rebotes por canal privado; aceptación local es diferente de entrega remota.

Al deshabilitar recuperación se impiden nuevos encolados y los pendientes fallan al procesarse. Para un incidente de MTA, inspeccionar por Message-ID/ID de cola privado, detener/rechazar la salida con autorización de infraestructura y pedir otro enlace cuando sea seguro. Los mensajes aceptados antes de un reset pueden seguir en el spool, pero sus enlaces quedan inválidos. No reinyectar payloads UNCERTAIN ni garantizar deduplicación por Message-ID.
