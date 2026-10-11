"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export function AccessForm() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const search = useSearchParams();
  const needsKit = search.get("requiere") === "kit";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/acceso", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = await response.json() as { ok?: boolean; scope?: "core" | "kit"; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || "No fue posible entrar.");
      router.replace(needsKit ? "/herramientas/kit-grupo" : "/herramientas");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible entrar.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="access-form" onSubmit={submit} noValidate>
      <label htmlFor="access-code">Código de acceso</label>
      <div className="access-row">
        <input
          id="access-code"
          name="access-code"
          type="password"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Escribe el código de tu entrega"
          maxLength={128}
          required
          aria-describedby={error ? "access-error" : "access-help"}
        />
        <button className="button" disabled={!code.trim() || loading} type="submit">
          {loading ? "Revisando…" : "Entrar"}
        </button>
      </div>
      <p id="access-help" className="form-help">Tu código se valida en el servidor y no se guarda en este dispositivo.</p>
      {needsKit && <p className="notice compact">Tu código de acceso abre el paquete completo, incluido el Kit del grupo.</p>}
      {error && <p id="access-error" className="form-error" role="alert">{error}</p>}
    </form>
  );
}
