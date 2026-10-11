import Link from "next/link";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
export const dynamic = "force-dynamic";

export default function HomePage() {
  return <main>
    <SiteHeader />
    <section className="section">
      <span className="eyebrow">Portal de pruebas</span>
      <h1>Catálogo sintético</h1>
      <p>Este ejemplo contiene datos inventados para comprobar el software. No incluye material comercial ni información de clientes.</p>
      <p>Los 480 registros, nueve grados y diez documentos de prueba conservan la estructura que verifican los contratos de acceso.</p>
      <Link className="button" href="/acceso">Entrar al entorno de prueba</Link>
    </section>
    <SiteFooter />
  </main>;
}
