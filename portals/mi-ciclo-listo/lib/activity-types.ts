export type Activity = {
  id: string;
  nivel?: "preescolar" | "primaria";
  fuente?: string;
  revisionPedagogica?: string;
  grado: string;
  campo: string;
  titulo: string;
  eje: string;
  duracion: string;
  modalidad: string;
  proposito: string;
  observacion: string;
  materiales: string[];
  pasos: string[];
  sugerencia: string;
};
