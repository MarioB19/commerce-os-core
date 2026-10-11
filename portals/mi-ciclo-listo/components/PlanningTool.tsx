"use client";

import { useEffect, useMemo, useState } from "react";
import type { Activity } from "@/lib/activity-types";
import { gradeLevel } from "@/lib/grade-profiles";
import { searchKey } from "@/lib/text";

const STORAGE_KEY = "mcl:planeacion:v1";
const MAX_SELECTION = 5;

type SavedState = {
  version: 1;
  grade: string;
  selectedIds: string[];
  weekTitle: string;
  weekDate: string;
  paper: "letter" | "a4";
};

export function PlanningTool({ activities, grades, fields }: { activities: Activity[]; grades: string[]; fields: string[] }) {
  const [grade, setGrade] = useState("");
  const [level, setLevel] = useState("");
  const [field, setField] = useState("");
  const [modality, setModality] = useState("");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [weekTitle, setWeekTitle] = useState("Mi semana lista");
  const [weekDate, setWeekDate] = useState("");
  const [paper, setPaper] = useState<"letter" | "a4">("letter");
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState("");

  const modalities = useMemo(
    () => [...new Set(activities.filter((item) => !grade || item.grado === grade).map(({ modalidad }) => modalidad))].sort((a, b) => a.localeCompare(b, "es")),
    [activities, grade],
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as SavedState | null;
        if (saved?.version === 1) {
          const savedGrade = grades.includes(saved.grade) ? saved.grade : "";
          setGrade(savedGrade);
          setLevel(gradeLevel(savedGrade));
          setSelectedIds(saved.selectedIds.filter((id) => activities.some((item) => item.id === id && item.grado === savedGrade)).slice(0, MAX_SELECTION));
          setWeekTitle(saved.weekTitle || "Mi semana lista");
          setWeekDate(saved.weekDate || "");
          setPaper(saved.paper === "a4" ? "a4" : "letter");
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
      setHydrated(true);
    });
    return () => { active = false; };
  }, [activities, grades]);

  useEffect(() => {
    if (!hydrated) return;
    const state: SavedState = { version: 1, grade, selectedIds, weekTitle, weekDate, paper };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [grade, hydrated, paper, selectedIds, weekDate, weekTitle]);

  const filtered = useMemo(() => {
    if (!grade) return [];
    const needle = searchKey(query.trim());
    return activities.filter((item) => {
      if (item.grado !== grade || (field && item.campo !== field) || (modality && item.modalidad !== modality)) return false;
      if (!needle) return true;
      return searchKey([item.titulo, item.proposito, item.materiales.join(" "), item.eje].join(" ")).includes(needle);
    });
  }, [activities, field, grade, modality, query]);

  const selected = selectedIds.map((id) => activities.find((item) => item.id === id)).filter((item): item is Activity => Boolean(item));

  function changeLevel(next: string) {
    if (selectedIds.length && !window.confirm("Cambiar de nivel quitará la selección actual. ¿Continuar?")) return;
    setLevel(next); setGrade(""); setSelectedIds([]); setField(""); setModality(""); setQuery("");
  }

  function changeGrade(next: string) {
    if (grade && next !== grade && selectedIds.length && !window.confirm("Cambiar de grado quitará la selección actual. ¿Continuar?")) return;
    setGrade(next);
    setSelectedIds([]);
    setField("");
    setModality("");
    setMessage("");
  }

  function toggle(id: string) {
    setMessage("");
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= MAX_SELECTION) {
        setMessage("Puedes elegir hasta cinco actividades por semana.");
        return current;
      }
      return [...current, id];
    });
  }

  function move(id: string, direction: -1 | 1) {
    setSelectedIds((current) => {
      const index = current.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function suggestWeek() {
    if (!grade) {
      setMessage("Primero elige un grado.");
      return;
    }
    const pool = [...filtered];
    if (!pool.length) {
      setMessage("No hay actividades con esos filtros. Prueba quitando uno.");
      return;
    }
    const byField = new Map<string, Activity[]>();
    for (const item of pool) byField.set(item.campo, [...(byField.get(item.campo) || []), item]);
    const picked: Activity[] = [];
    for (const items of byField.values()) {
      picked.push(items[Math.floor(Math.random() * items.length)]);
      if (picked.length === MAX_SELECTION) break;
    }
    for (const item of pool.sort(() => Math.random() - 0.5)) {
      if (picked.length === MAX_SELECTION) break;
      if (!picked.some(({ id }) => id === item.id)) picked.push(item);
    }
    setSelectedIds(picked.map(({ id }) => id));
    setMessage("Sugerimos una mezcla inicial. Revísala y ajústala con tu criterio.");
  }

  function clearLocal() {
    if (!window.confirm("¿Borrar la planeación y los datos guardados en este navegador?")) return;
    localStorage.removeItem(STORAGE_KEY);
    setGrade("");
    setLevel("");
    setField("");
    setModality("");
    setQuery("");
    setSelectedIds([]);
    setWeekTitle("Mi semana lista");
    setWeekDate("");
    setPaper("letter");
    setMessage("Datos locales borrados.");
  }

  return (
    <>
      <style>{`@media print { @page { size: ${paper === "a4" ? "A4" : "letter"}; margin: 12mm; } }`}</style>
      <section className="builder-shell planning-shell">
        <aside className="filter-panel no-print">
          <span className="eyebrow">Paso 1</span>
          <h1>Arma tu semana</h1>
          <p className="panel-intro">El nivel y el grado son obligatorios. Después puedes afinar o buscar con palabras cotidianas.</p>

          <label htmlFor="level">Nivel <strong aria-hidden="true">*</strong></label>
          <select id="level" value={level} onChange={(event) => changeLevel(event.target.value)} required><option value="">Elige un nivel</option><option value="preescolar">Preescolar</option><option value="primaria">Primaria</option></select>
          <label htmlFor="grade">Grado <strong aria-hidden="true">*</strong></label>
          <select id="grade" disabled={!level} value={grade} onChange={(event) => changeGrade(event.target.value)} required>
            <option value="">Elige un grado</option>
            {grades.filter((item) => gradeLevel(item) === level).map((item) => <option key={item}>{item}</option>)}
          </select>

          <label htmlFor="search">Buscar actividad</label>
          <input id="search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ej. nombres, patio, contar…" disabled={!grade} />

          <label htmlFor="field">Campo formativo</label>
          <select id="field" value={field} onChange={(event) => setField(event.target.value)} disabled={!grade}>
            <option value="">Todos los campos</option>
            {fields.map((item) => <option key={item}>{item}</option>)}
          </select>

          <label htmlFor="modality">Modalidad</label>
          <select id="modality" value={modality} onChange={(event) => setModality(event.target.value)} disabled={!grade}>
            <option value="">Todas las modalidades</option>
            {modalities.map((item) => <option key={item}>{item}</option>)}
          </select>

          <button className="button button-wide" type="button" onClick={suggestWeek}>Sugerir una semana</button>
          <button className="danger-link" type="button" onClick={clearLocal}>Borrar datos de este navegador</button>
          <p className="local-note">Guardado local automático</p>
        </aside>

        <div className="results-panel no-print">
          <div className="results-heading">
            <div><span className="eyebrow">Paso 2</span><h2>Elige hasta cinco</h2></div>
            <strong>{selected.length}/{MAX_SELECTION}</strong>
          </div>
          {message && <p className="tool-message" role="status">{message}</p>}
          {!grade ? (
            <div className="empty-state"><span aria-hidden="true">1</span><h3>Primero elige un grado</h3><p>Así evitamos mezclar actividades con niveles distintos.</p></div>
          ) : filtered.length ? (
            <div className="activity-list" aria-label={`${filtered.length} actividades encontradas`}>
              {filtered.map((item) => {
                const active = selectedIds.includes(item.id);
                return (
                  <article className={`activity-card ${active ? "selected" : ""}`} key={item.id}>
                    <div className="activity-meta"><span>{item.campo}</span><span>{item.duracion}</span></div>
                    <h3>{item.titulo}</h3>
                    <p>{item.proposito}</p>
                    <details><summary>Ver materiales y pasos</summary><p><strong>Materiales:</strong> {item.materiales.join(", ")}.</p><ol>{item.pasos.map((step) => <li key={step}>{step}</li>)}</ol></details>
                    <button className={active ? "select-button remove" : "select-button"} type="button" onClick={() => toggle(item.id)} aria-pressed={active}>
                      {active ? "Quitar de mi semana" : "Agregar a mi semana"}
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty-state"><span aria-hidden="true">0</span><h3>No encontramos coincidencias</h3><p>Prueba con menos palabras o quita un filtro.</p></div>
          )}
        </div>

        <aside className="selection-panel no-print">
          <span className="eyebrow">Paso 3</span>
          <h2>Tu selección</h2>
          {selected.length ? (
            <ol className="selected-list">
              {selected.map((item, index) => (
                <li key={item.id}>
                  <span>{index + 1}</span>
                  <div><strong>{item.titulo}</strong><small>{item.campo}</small></div>
                  <div className="reorder">
                    <button type="button" onClick={() => move(item.id, -1)} disabled={index === 0} aria-label={`Subir ${item.titulo}`}>↑</button>
                    <button type="button" onClick={() => move(item.id, 1)} disabled={index === selected.length - 1} aria-label={`Bajar ${item.titulo}`}>↓</button>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="quiet">Aquí aparecerán las actividades que elijas.</p>}
          <label htmlFor="week-title">Título</label>
          <input id="week-title" value={weekTitle} onChange={(event) => setWeekTitle(event.target.value)} maxLength={80} />
          <label htmlFor="week-date">Semana del</label>
          <input id="week-date" type="date" value={weekDate} onChange={(event) => setWeekDate(event.target.value)} />
          <label htmlFor="paper">Papel</label>
          <select id="paper" value={paper} onChange={(event) => setPaper(event.target.value as "letter" | "a4")}>
            <option value="letter">Carta</option><option value="a4">A4</option>
          </select>
          <button className="button button-wide" type="button" onClick={() => window.print()} disabled={!selected.length}>Imprimir / guardar PDF</button>
        </aside>
      </section>

      <section className={`print-sheet ${paper}`} aria-label="Planeación lista para imprimir">
        <header className="print-header"><span>Mi Ciclo Listo</span><h1>{weekTitle || "Mi semana lista"}</h1><p>{grade}{weekDate ? ` · Semana del ${new Date(`${weekDate}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" })}` : ""}</p></header>
        {selected.map((item, index) => (
          <article className="print-activity" key={item.id}>
            <div className="print-number">{String(index + 1).padStart(2, "0")}</div>
            <div className="print-activity-body">
              <p className="print-meta">{item.campo} · {item.duracion} · {item.modalidad}</p>
              <h2>{item.titulo}</h2>
              <p><strong>Propósito.</strong> {item.proposito}</p>
              <p><strong>Materiales.</strong> {item.materiales.join(", ")}.</p>
              <ol>{item.pasos.map((step) => <li key={step}>{step}</li>)}</ol>
              <div className="observation"><strong>Qué observar</strong><p>{item.observacion}</p></div>
              {item.sugerencia && <p className="practical-tip"><strong>Sugerencia práctica:</strong> {item.sugerencia}</p>}
            </div>
          </article>
        ))}
        <footer className="print-footer">Material independiente de apoyo docente · Adapta cada actividad a tu grupo y contexto.</footer>
      </section>
    </>
  );
}
