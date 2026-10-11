import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { canUse, getAccessSession } from "@/lib/auth";
import { findDownload } from "@/lib/downloads";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const session = await getAccessSession();
  if (!session) return NextResponse.json({ error: "Acceso requerido." }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const { slug } = await context.params;
  const item = findDownload(slug);
  if (!item) return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
  if (!canUse(session.scope, item.required)) return NextResponse.json({ error: "Tu código no incluye este archivo." }, { status: 403, headers: { "Cache-Control": "no-store" } });

  const filePath = path.join(process.cwd(), "private", "pdfs", item.fileName);
  const file = await readFile(filePath);
  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
