import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();

export const metadata: Metadata = {
  metadataBase: siteUrl ? new URL(siteUrl) : undefined,
  title: { default: "Mi Ciclo Listo | Biblioteca docente", template: "%s | Mi Ciclo Listo" },
  description: "Portal privado de herramientas y soporte de Mi Ciclo Listo para preescolar y primaria.",
  alternates: { canonical: "/" },
  robots: { index: false, follow: false, nocache: true },
  openGraph: {
    title: "Mi Ciclo Listo",
    description: "Tu biblioteca docente, ordenada y lista para usar.",
    url: "/",
    type: "website",
    locale: "es_MX",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-MX" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
