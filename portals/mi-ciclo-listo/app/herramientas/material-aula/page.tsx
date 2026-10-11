import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClassroomMaterialTool } from "@/components/ClassroomMaterialTool";
import { getAccessSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Material del aula" };

export default async function ClassroomMaterialPage() {
  const session = await getAccessSession();
  if (!session) redirect("/acceso");
  return <ClassroomMaterialTool />;
}
