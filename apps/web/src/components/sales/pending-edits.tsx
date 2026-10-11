import { useEffect } from "react";
import { useBlocker } from "@tanstack/react-router";
import { Modal } from "../ui/dialog";
import { Button } from "../ui/button";
export function PendingEdits({
  dirty,
  onBlocked,
}: {
  dirty: boolean;
  onBlocked?: (message: string) => void;
}) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  useEffect(() => {
    const listener = (e: Event) => {
      if (dirty) {
        e.preventDefault();
        onBlocked?.("Guarda los cambios antes de cambiar de entorno.");
      }
    };
    window.addEventListener("commerce:context-change", listener);
    return () =>
      window.removeEventListener("commerce:context-change", listener);
  }, [dirty, onBlocked]);
  return (
    <Modal
      title="Hay cambios pendientes"
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
    >
      <p>
        Conservamos lo que escribiste. Guarda los cambios en esta sección antes
        de salir.
      </p>
      <Button onClick={() => blocker.reset?.()}>Volver y guardar</Button>
    </Modal>
  );
}
