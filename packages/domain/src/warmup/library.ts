/** Drafts only. Operators edit and approve legitimate internal tests explicitly. */
export const initialConversations = [
 'Presentación del equipo','Confirmación de lectura','Revisión del horario','Organización de una reunión',
 'Revisión de un documento','Comprobación de audio','Acuerdo de disponibilidad','Consulta de accesibilidad',
 'Revisión de una imagen','Registro de una incidencia','Cierre de una prueba','Confirmación de próximos pasos',
 'Consulta del calendario','Revisión de instrucciones','Preparación de material','Verificación de conexión',
 'Notas de una reunión','Revisión del checklist','Coordinación de soporte','Confirmación de responsables',
].map((label,i)=>({label,ownership_confirmed:true as const,turns:[
 {kind:'text' as const,text:`Prueba interna autorizada: ${label.toLowerCase()}. Soy parte del equipo y este mensaje es automatizado.`},
 {kind:'text' as const,text:`Recibido. Estamos comprobando la conversación interna ${i+1}.`},
 {kind:'text' as const,text:'La prueba sólo incluye a nuestros participantes autorizados. ¿Se lee el mensaje completo?'},
 {kind:'text' as const,text:'Sí, el contenido se recibió completo en este dispositivo de prueba.'},
 {kind:'text' as const,text:'Gracias. Registramos este intercambio para comprobar el funcionamiento del canal.'},
 {kind:'text' as const,text:'Confirmado. Cerramos esta conversación interna de prueba.'},
]}));
