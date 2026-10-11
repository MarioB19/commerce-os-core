import "server-only";
import type { AccessScope } from "@/lib/auth";

export type DownloadItem = {
  slug: string;
  label: string;
  fileName: string;
  required: AccessScope;
};

export const downloads: DownloadItem[] = [
  { slug: "paquete-completo", label: "Mi Ciclo Listo · 480 actividades · Nueve grados", fileName: "mi-ciclo-listo-paquete-completo.pdf", required: "core" },
  { slug: "bono-1", label: "Bono 1 · Tu primera semana lista", fileName: "bono-01-primera-semana-lista.pdf", required: "core" },
  { slug: "bono-2", label: "Bono 2 · Evaluación y observación", fileName: "bono-02-instrumentos-evaluacion-observacion.pdf", required: "core" },
  { slug: "bono-3", label: "Bono 3 · CTE y control de grupo", fileName: "bono-03-kit-cte-control-grupo.pdf", required: "core" },
  { slug: "bono-4", label: "Bono 4 · Banco de dinámicas", fileName: "bono-04-banco-dinamicas.pdf", required: "core" },
  { slug: "bono-5", label: "Bono 5 · Proyectos por temporada", fileName: "bono-05-proyectos-temporada.pdf", required: "core" },
  { slug: "bono-6", label: "Bono 6 · Diversidad del aula", fileName: "bono-06-adecuaciones-diversidad-aula.pdf", required: "core" },
  { slug: "bono-7", label: "Bono 7 · Cartas a las familias", fileName: "bono-07-cartas-comunicados-familias.pdf", required: "core" },
  { slug: "bono-8", label: "Bono 8 · Material recortable", fileName: "bono-08-material-recortable-aula.pdf", required: "core" },
];

export function findDownload(slug: string) {
  return downloads.find((item) => item.slug === slug);
}
