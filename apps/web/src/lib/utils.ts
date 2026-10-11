import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function money(
  amount: number | string | null | undefined,
  currency?: string,
) {
  if (amount == null || !Number.isFinite(Number(amount))) return "Sin dato";
  if (!currency)
    return `${(Number(amount) / 100).toLocaleString("es-MX")} · moneda desconocida`;
  const formatter = new Intl.NumberFormat("es-MX", { style: "currency", currency });
  return formatter.format(Number(amount) / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
}
export const date = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString("es-MX", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Sin dato";
export function downloadJson(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
export function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "Sin referencia";
}
