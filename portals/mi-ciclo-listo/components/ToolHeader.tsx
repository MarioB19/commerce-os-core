import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";

export function ToolHeader() {
  return (
    <header className="tool-header no-print">
      <Link className="brand compact-brand" href="/herramientas">
        <span className="brand-mark" aria-hidden="true">M</span>
        <span><strong>Mi Ciclo Listo</strong><small>Herramientas</small></span>
      </Link>
      <nav aria-label="Herramientas">
        <Link href="/herramientas/planeacion">Planeación</Link>
        <Link href="/herramientas/material-aula">Material</Link>
        <Link href="/herramientas/kit-grupo">Kit del grupo</Link>
      </nav>
      <LogoutButton />
    </header>
  );
}
