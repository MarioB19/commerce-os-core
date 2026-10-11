"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const LOCAL_KEYS = ["mcl:planeacion:v1", "mcl:material-aula:v1"];
const SESSION_KEYS = ["mcl:kit-grupo:v1"];

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function logout() {
    setBusy(true);
    setError("");
    for (const key of LOCAL_KEYS) localStorage.removeItem(key);
    for (const key of SESSION_KEYS) sessionStorage.removeItem(key);
    try {
      const response = await fetch("/api/salir", { method: "POST" });
      if (!response.ok) throw new Error("logout_failed");
      router.replace("/");
      router.refresh();
    } catch {
      setError("No pudimos cerrar la sesión. Intenta de nuevo.");
      setBusy(false);
    }
  }

  return (
    <div className="logout-control">
      <button className="link-button" type="button" onClick={logout} disabled={busy}>{busy ? "Saliendo…" : "Salir y borrar datos"}</button>
      {error && <span className="logout-error" role="alert">{error}</span>}
    </div>
  );
}
