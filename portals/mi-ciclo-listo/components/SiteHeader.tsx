import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="Mi Ciclo Listo, inicio">
        <span className="brand-mark" aria-hidden="true">M</span>
        <span>
          <strong>Mi Ciclo Listo</strong>
          <small>Biblioteca docente</small>
        </span>
      </Link>
      <nav aria-label="Navegación principal">
        <Link href="/">Inicio</Link>
        <Link href="/privacidad">Privacidad</Link>
        <Link className="button button-small" href="/acceso">Entrar</Link>
      </nav>
    </header>
  );
}
