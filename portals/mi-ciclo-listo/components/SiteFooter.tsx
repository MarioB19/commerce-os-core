import Link from "next/link";
import {supportContact} from "@/lib/support";

export function SiteFooter() {
  const support=supportContact();
  return (
    <footer className="site-footer">
      <div>
        <strong>Mi Ciclo Listo</strong>
        <p>Material independiente de apoyo a la práctica docente, creado por Inovaris.</p>
      </div>
      <div className="footer-links">
        <Link href="/privacidad">Privacidad</Link>
        {support&&<a href={support.href}>Soporte</a>}
        <Link href="/acceso">Acceso a herramientas</Link>
      </div>
    </footer>
  );
}
