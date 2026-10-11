# ADR · V1 compartida de Inteligencia y Estudio

Fecha 2026-09-08. Aprobación anticipada: solicitud adjunta de Brandon en tarea 01a08165-d932-74a2-ae51-2c25e9f1626a; SHA de solicitud registrado en evidencia. Cubre código, servicios mínimos, piloto acotado, instalación, merge y CI/CD; excluye mensajes/campañas/Ads y no reemplaza revisión editorial humana.

Base origin/main 0f6a3e6, worktree codex/intelligence-studio-team-v1. Se conserva legado y migraciones0001–0028. API/PostgreSQL autoridad; Remotion4.0.503 portable, Tauri2/Node24 sidecar; R2 privado y transferencia directa. Tokens equipo separados de usuario; scopes explícitos sin heredar privilegios de Ventas. Render serial por equipo, dos por workspace. Operaciones pagadas independientes de attempts.

R2 no ofrece SHA256 FULL_OBJECT por S3. Para verificar bytes sin transmitir masters por VPS se incorpora un verificador mínimo Cloudflare Worker vinculado únicamente al bucket: lee objeto cerrado, calcula SHA256 por stream y devuelve receipt autenticado. No render ni transcodificación allí. Servidor conserva decisión READY/promoción. Sin verificador remoto disponible, READY queda bloqueado; la prueba local no acredita R2.

Supuestos: almacenamiento piloto máximo2GiB durables más staging, sin borrado de fuentes aprobadas; proveedor y cuota deshabilitados hasta registrar autorización/coste. El titular del equipo autoriza proyectos mediante pairing. Macarm64 y Windowsx64; certificados ausentes implican distribución interna asistida, nunca desactivar OS.
