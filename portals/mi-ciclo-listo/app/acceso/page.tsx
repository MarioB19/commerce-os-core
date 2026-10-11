import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccessForm } from "@/components/AccessForm";
import { SiteHeader } from "@/components/SiteHeader";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Acceso de prueba" };

export default function AccessPage() {
  return <main className="access-page">
    <SiteHeader />
    <section className="access-shell">
      <div className="access-copy">
        <span className="eyebrow">Contenido sintético</span>
        <h1>Acceso al entorno de prueba</h1>
        <p>Usa únicamente el código del entorno de prueba. Los fixtures no incluyen credenciales ni códigos de producción.</p>
        <Suspense fallback={<p className="form-help">Cargando acceso…</p>}><AccessForm /></Suspense>
        <Link className="text-link" href="/">← Volver al inicio</Link>
      </div>
    </section>
  </main>;
}
