import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAccessSession } from "@/lib/auth";
import { downloads } from "@/lib/downloads";
export const metadata: Metadata = { title: "Herramientas de prueba" };
const tools = [
  ["/herramientas/planeacion", "Planeación", "Consulta y filtra los registros sintéticos."],
  ["/herramientas/material-aula", "Material del aula", "Prueba los formularios y la impresión."],
  ["/herramientas/kit-grupo", "Kit del grupo", "Verifica el permiso adicional de acceso."],
] as const;

export default async function ToolsPage() {
  const session = await getAccessSession();
  if (!session) redirect("/acceso");
  return <section className="tools-home">
    <header className="tools-home-heading"><div><h1>Herramientas de prueba</h1></div><p>Usa datos inventados. El contenido de este perfil no sirve como material pedagógico ni comercial.</p></header>
    <div className="app-grid">{tools.map(([href, title, description]) => <Link className="app-card" href={href} key={href}><div className="app-card-copy"><h2>{title}</h2><p>{description}</p><strong>Abrir →</strong></div></Link>)}</div>
    <section className="download-panel">
      <div><h2>Documentos sintéticos</h2><p>Las descargas mantienen los controles de sesión y permisos.</p></div>
      <div className="download-list">{downloads.map((item) => <a key={item.slug} href={`/api/descargas/${item.slug}`}>{item.label}<span>PDF ↓</span></a>)}</div>
    </section>
    <p className="privacy-reminder">Utiliza nombres inventados y borra los datos de prueba desde cada herramienta.</p>
  </section>;
}
