import { redirect } from "next/navigation";
import { getAccessSession } from "@/lib/auth";
import { ToolHeader } from "@/components/ToolHeader";

export const dynamic = "force-dynamic";

export default async function ToolsLayout({ children }: { children: React.ReactNode }) {
  const session = await getAccessSession();
  if (!session) redirect("/acceso");

  return (
    <main className="tools-app">
      <ToolHeader />
      {children}
    </main>
  );
}
