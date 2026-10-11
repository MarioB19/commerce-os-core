export const gradeLabels = [
  ...Array.from({ length: 3 }, (_, i) => `${i + 1}.º de preescolar`),
  ...Array.from({ length: 6 }, (_, i) => `${i + 1}.º de primaria`),
];
export function gradeLevel(grade: string): string {
  return grade.includes("primaria") ? "primaria" : grade.includes("preescolar") ? "preescolar" : "";
}
export const primaryProfiles = [
  { numbers: ["1", "5", "8", "10", "12", "17", "20", "7 + 5"], language: ["Mi nombre", "Inicial", "Primero", "Después", "Al final", "Dibujo", "Dicto", "Reviso"], advances: ["Reconozco mi nombre", "Cuento objetos", "Explico un dibujo", "Comparto materiales", "Pido ayuda", "Reviso mi trabajo"] },
  { numbers: ["10", "24", "36", "48", "84", "1/2", "1/4", "24 ÷ 4"], language: ["Destinatario", "Petición", "Firma", "Pregunta", "Respuesta", "Título", "Recomiendo", "Reviso"], advances: ["Escribo un recado", "Agrupo decenas", "Reparto con objetos", "Registro datos", "Respeto turnos", "Reviso instrucciones"] },
  { numbers: ["4 × 23", "92", "1/2", "1/3", "1/4", "6 × 4", "20 cm", "Una unidad"], language: ["Qué", "Quién", "Cuándo", "Dónde", "Dato", "Opinión", "Fuente", "Pregunta"], advances: ["Explico con evidencia", "Multiplico con sentido", "Comparo fracciones", "Mido un borde", "Escucho propuestas", "Ajusto mi plan"] },
  { numbers: ["24 × 13", "312", "3/4", "6/8", "24 u²", "20 u", "22 u", "60 datos"], language: ["Coincidencia", "Diferencia", "Proceso", "Conector", "Propuesta", "Razón", "Observación", "Inferencia"], advances: ["Comparo fuentes", "Descompongo productos", "Relaciono fracciones", "Distingo área y borde", "Negocio con respeto", "Doy una sugerencia útil"] },
  { numbers: ["18.50", "7.25", "70.00", "3/4 × 2", "3/8", "Escala 1:100", "Media: 18", "Mediana: 15"], language: ["Postura", "Razón", "Ejemplo", "Objeción", "Resumen", "Autoría", "Consentimiento", "Límite"], advances: ["Argumento con respaldo", "Calculo decimales", "Uso una escala", "Interpreto datos", "Anticipo riesgos", "Cuido datos personales"] },
  { numbers: ["25% de 800", "15% de 800", "60%", "Razón 2:3", "24 u³", "2/5", "3/5", "Frecuencia"], language: ["Afirmación", "Evidencia", "Criterio", "Perspectiva", "Discrepancia", "Hipótesis", "Atribución", "Revisión"], advances: ["Contrasto evidencias", "Explico porcentajes", "Uso proporcionalidad", "Distingo azar y resultado", "Evalúo un proyecto", "Planeo mi siguiente etapa"] },
];
export function getPrimaryProfile(grade: string) {
  if (gradeLevel(grade) !== "primaria") return null;
  return primaryProfiles[Number.parseInt(grade, 10) - 1] ?? null;
}
