import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PlanningTool } from "@/components/PlanningTool";
import { activities, fields, grades } from "@/lib/activities";
import { getAccessSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Generador de planeación" };

export default async function PlanningPage() {
  const session = await getAccessSession();
  if (!session) redirect("/acceso");
  return <PlanningTool activities={activities} grades={grades} fields={fields} />;
}
