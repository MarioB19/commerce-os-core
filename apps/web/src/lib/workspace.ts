import { createContext, useContext } from "react";
import type { Environment, Session } from "./api";
export interface WorkspaceScope {
  environment: Environment;
  session: Session;
}
export const WorkspaceContext = createContext<WorkspaceScope | null>(null);
export function useWorkspace(): WorkspaceScope {
  const context = useContext(WorkspaceContext);
  if (!context?.session.workspace_id) throw new Error("No hay un contexto de workspace válido. Vuelve a iniciar sesión.");
  return context;
}
