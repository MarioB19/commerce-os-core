import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { GroupKitTool } from "@/components/GroupKitTool";
import { canUse, getAccessSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Kit del grupo" };

export default async function GroupKitPage() {
  const session = await getAccessSession();
  if (!session || !canUse(session.scope, "kit")) redirect("/acceso?requiere=kit");
  return <GroupKitTool />;
}
