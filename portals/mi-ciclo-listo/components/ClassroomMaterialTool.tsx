"use client";

import { useEffect, useMemo, useState } from "react";
import { gradeLabels, gradeLevel, getPrimaryProfile } from "@/lib/grade-profiles";
import { CardIcon } from "@/components/CardIcon";

type Card = { id: string; icon: string; label: string; prompt?: string };
type SetKey = "rutinas" | "responsabilidades" | "areas" | "senales" | "emociones" | "clima" | "numeros" | "palabras";

const preschoolSets: Record<SetKey, { title: string; description: string; cards: Card[] }> = {
  rutinas: { title: "Rutina del día", description: "Ordena las tarjetas y colócalas a la vista.", cards: [
    { id: "entrada", icon: "👋", label: "Llegamos" }, { id: "saludo", icon: "🎵", label: "Saludo" }, { id: "circulo", icon: "◯", label: "Círculo" },
    { id: "actividad", icon: "✏️", label: "Actividad" }, { id: "lavado", icon: "🧼", label: "Lavamos manos" }, { id: "comida", icon: "🍎", label: "Colación" },
    { id: "patio", icon: "☀️", label: "Patio" }, { id: "cuento", icon: "📖", label: "Cuento" }, { id: "guardar", icon: "🧺", label: "Guardamos" }, { id: "salida", icon: "🏠", label: "Salida" },
  ]},
  responsabilidades: { title: "Responsabilidades", description: "Asigna por turnos, sin fijar tareas por género.", cards: [
    { id: "material", icon: "✏️", label: "Materiales" }, { id: "plantas", icon: "🌱", label: "Plantas" }, { id: "libros", icon: "📚", label: "Libros" },
    { id: "mesa", icon: "✨", label: "Mesas" }, { id: "fila", icon: "👣", label: "Fila" }, { id: "calendario", icon: "📅", label: "Calendario" },
    { id: "ventanas", icon: "🪟", label: "Ventanas" }, { id: "reciclaje", icon: "♻️", label: "Reciclaje" },
  ]},
  areas: { title: "Áreas del aula", description: "Etiquetas visuales para organizar el salón.", cards: [
    { id: "biblioteca", icon: "📖", label: "Biblioteca" }, { id: "arte", icon: "🎨", label: "Arte" }, { id: "ciencia", icon: "🔎", label: "Ciencia" },
    { id: "construccion", icon: "🧱", label: "Construcción" }, { id: "juego", icon: "🧸", label: "Juego" }, { id: "materiales", icon: "🧺", label: "Materiales" },
    { id: "trabajos", icon: "🖼️", label: "Nuestros trabajos" }, { id: "calma", icon: "🌿", label: "Espacio de calma" },
  ]},
  senales: { title: "Señales del grupo", description: "Apoyos breves; enséñalos antes de esperar que funcionen.", cards: [
    { id: "escucho", icon: "👂", label: "Escucho" }, { id: "espero", icon: "✋", label: "Espero mi turno" }, { id: "camino", icon: "🚶", label: "Camino despacio" },
    { id: "guardo", icon: "🧺", label: "Guardo al terminar" }, { id: "ayuda", icon: "🤝", label: "Pido ayuda" }, { id: "agua", icon: "💧", label: "Cuido el agua" },
    { id: "voz", icon: "🗣️", label: "Voz suave" }, { id: "cuidado", icon: "🫧", label: "Nos cuidamos" },
  ]},
  emociones: { title: "¿Cómo me siento?", description: "Invita a señalar; no obligues a explicar.", cards: [
    { id: "alegre", icon: "😊", label: "Alegre" }, { id: "tranquilo", icon: "😌", label: "En calma" }, { id: "triste", icon: "😔", label: "Triste" },
    { id: "enojado", icon: "😠", label: "Enojado" }, { id: "miedo", icon: "😟", label: "Con miedo" }, { id: "cansado", icon: "🥱", label: "Cansado" },
    { id: "emocionado", icon: "🤩", label: "Emocionado" }, { id: "confundido", icon: "🤔", label: "Confundido" },
  ]},
  clima: { title: "El clima de hoy", description: "Elijan una tarjeta al iniciar la jornada.", cards: [
    { id: "soleado", icon: "☀️", label: "Soleado" }, { id: "nublado", icon: "☁️", label: "Nublado" }, { id: "lluvia", icon: "🌧️", label: "Lluvioso" },
    { id: "viento", icon: "🌬️", label: "Con viento" }, { id: "frio", icon: "❄️", label: "Hace frío" }, { id: "calor", icon: "🌡️", label: "Hace calor" },
  ]},
  numeros: { title: "Números del 1 al 10", description: "Tarjetas grandes para juegos de orden y cantidad.", cards: Array.from({ length: 10 }, (_, index) => ({ id: `n-${index + 1}`, icon: String(index + 1), label: `${index + 1}` })) },
  palabras: { title: "Palabras para convivir", description: "Frases cortas para modelar en situaciones reales.", cards: [
    { id: "porfavor", icon: "🤲", label: "Por favor" }, { id: "gracias", icon: "💛", label: "Gracias" }, { id: "permiso", icon: "🚪", label: "¿Me das permiso?" },
    { id: "turno", icon: "🔄", label: "¿Me das turno?" }, { id: "ayudas", icon: "🤝", label: "¿Me ayudas?" }, { id: "presto", icon: "🎁", label: "Te lo presto" },
    { id: "gusta", icon: "💬", label: "Eso no me gusta" }, { id: "acuerdo", icon: "✅", label: "Hagamos un acuerdo" },
  ]},
};

function getSets(grade: string): typeof preschoolSets {
  const profile = getPrimaryProfile(grade);
  if (!profile) return preschoolSets;
  const makeCards = (prefix: string, labels: string[]) => labels.map((label, index) => ({ id: `${prefix}-${index}`, icon: "", label }));
  return {
    ...preschoolSets,
    rutinas: { title: "Ruta de trabajo", description: `${grade}: organiza una tarea y revisa su resultado.`, cards: makeCards("pri-rutina", ["Leo el reto", "Pregunto", "Planeo", "Busco evidencia", "Represento", "Explico", "Escucho", "Reviso", "Comparto", "Organizo"]) },
    responsabilidades: { title: "Roles del proyecto", description: "Acuerda y rota los roles; cada persona conserva decisiones.", cards: makeCards("pri-rol", ["Materiales", "Lectura", "Registro", "Tiempo", "Verificación", "Presentación", "Accesibilidad", "Orden"]) },
    areas: { title: "Espacios de investigación", description: "Adapta las etiquetas a los espacios reales del aula.", cards: makeCards("pri-area", ["Biblioteca", "Fuentes", "Experimentos", "Proyectos", "Debate", "Materiales", "Producciones", "Espacio de calma"]) },
    numeros: { title: "Tarjetas matemáticas", description: `${grade}: representa, compara y explica. Cada tarjeta se conecta con actividades del paquete.`, cards: makeCards("pri-numero", profile.numbers) },
    palabras: { title: "Palabras para pensar", description: `${grade}: usa las tarjetas para explicar tus decisiones.`, cards: makeCards("pri-palabra", profile.language) },
  };
}

const STORAGE_KEY = "mcl:material-aula:v1";
type Saved = { version: 1; grade?: string; setKey: SetKey; selected: string[]; palette: "verde" | "azul" | "terracota"; paper: "letter" | "a4" };

export function ClassroomMaterialTool() {
  const [grade, setGrade] = useState("");
  const [level, setLevel] = useState("");
  const sets = useMemo(() => getSets(grade), [grade]);
  const [setKey, setSetKey] = useState<SetKey>("rutinas");
  const [selected, setSelected] = useState<string[]>([]);
  const [palette, setPalette] = useState<"verde" | "azul" | "terracota">("verde");
  const [paper, setPaper] = useState<"letter" | "a4">("letter");
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Saved | null;
        if (saved?.version === 1 && saved.setKey in preschoolSets) {
          const savedGrade = saved.grade === undefined ? "1.º de preescolar" : gradeLabels.includes(saved.grade) ? saved.grade : "";
          setGrade(savedGrade); setLevel(gradeLevel(savedGrade));
          const restoredSets = getSets(savedGrade);
          setSetKey(saved.setKey); setSelected(saved.selected.filter((id) => restoredSets[saved.setKey].cards.some((card) => card.id === id)));
          setPalette(["verde", "azul", "terracota"].includes(saved.palette) ? saved.palette : "verde"); setPaper(saved.paper === "a4" ? "a4" : "letter");
        }
      } catch { localStorage.removeItem(STORAGE_KEY); }
      setHydrated(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, grade, setKey, selected, palette, paper } satisfies Saved));
  }, [grade, hydrated, palette, paper, selected, setKey]);

  const current = grade ? sets[setKey] : { title: "Elige nivel y grado", description: "Las tarjetas se adaptan después de seleccionar tu grupo.", cards: [] };
  const cards = useMemo(() => current.cards.filter(({ id }) => selected.includes(id)), [current.cards, selected]);

  function chooseGrade(value: string) {
    setGrade(value); setSetKey("numeros"); setSelected(getSets(value).numeros.cards.map(({ id }) => id));
  }

  function chooseSet(value: SetKey) {
    setSetKey(value); setSelected(sets[value].cards.map(({ id }) => id)); setMessage("");
  }

  function clearLocal() {
    if (!window.confirm("¿Borrar la selección guardada en este navegador?")) return;
    localStorage.removeItem(STORAGE_KEY); setGrade(""); setLevel(""); setSetKey("rutinas"); setSelected([]); setPalette("verde"); setPaper("letter"); setMessage("Datos locales borrados.");
  }

  return (
    <>
      <style>{`@media print { @page { size: ${paper === "a4" ? "A4" : "letter"}; margin: 10mm; } }`}</style>
      <section className="builder-shell material-shell">
        <aside className="filter-panel no-print">
          <span className="eyebrow">Material del aula</span><h1>Visuales para recortar</h1>
          <p className="panel-intro">Ocho juegos por nivel; tarjetas matemáticas y de lenguaje diferenciadas para cada grado de primaria. Elige solo las tarjetas que tu grupo necesita.</p>
          <label htmlFor="material-level">Nivel</label><select id="material-level" value={level} onChange={(event) => { setLevel(event.target.value); setGrade(""); setSelected([]); }}><option value="">Elige un nivel</option><option value="preescolar">Preescolar</option><option value="primaria">Primaria</option></select>
          <label htmlFor="material-grade">Grado</label><select id="material-grade" disabled={!level} value={grade} onChange={(event) => chooseGrade(event.target.value)}><option value="">Elige un grado</option>{gradeLabels.filter((g) => gradeLevel(g) === level).map((g) => <option key={g}>{g}</option>)}</select>
          <label htmlFor="material-set">Juego</label>
          <select id="material-set" disabled={!grade} value={setKey} onChange={(event) => chooseSet(event.target.value as SetKey)}>
            {Object.entries(sets).map(([key, value]) => <option value={key} key={key}>{value.title}</option>)}
          </select>
          <label htmlFor="palette">Color</label><select id="palette" value={palette} onChange={(event) => setPalette(event.target.value as typeof palette)}><option value="verde">Verde pizarrón</option><option value="azul">Azul sereno</option><option value="terracota">Terracota</option></select>
          <label htmlFor="paper-material">Papel</label><select id="paper-material" value={paper} onChange={(event) => setPaper(event.target.value as "letter" | "a4")}><option value="letter">Carta</option><option value="a4">A4</option></select>
          <button className="danger-link" type="button" onClick={clearLocal}>Borrar datos de este navegador</button>
          <p className="local-note">Guardado local automático · versión 1</p>
        </aside>

        <div className="material-editor no-print">
          <div className="results-heading"><div><span className="eyebrow">Personaliza</span><h2>{current.title}</h2></div><strong>{cards.length}/{current.cards.length}</strong></div>
          <p>{current.description}</p>
          <div className={`visual-card-grid ${palette}`}>
            {current.cards.map((card) => {
              const active = selected.includes(card.id);
              return <button className={`visual-card ${active ? "active" : ""}`} type="button" key={card.id} onClick={() => setSelected((items) => active ? items.filter((id) => id !== card.id) : [...items, card.id])} aria-pressed={active}><span className="card-icon" aria-hidden="true"><CardIcon id={card.id} label={card.label} /></span><strong>{card.label}</strong><small>{active ? "Incluida" : "No imprimir"}</small></button>;
            })}
          </div>
          {message && <p className="tool-message" role="status">{message}</p>}
        </div>

        <aside className="selection-panel no-print">
          <span className="eyebrow">Vista final</span><h2>{cards.length} tarjetas</h2>
          <p className="quiet">Recorta por las líneas continuas. Si plastificas, deja un margen alrededor.</p>
          <button className="button button-wide" type="button" disabled={!grade || !cards.length} onClick={() => window.print()}>Imprimir / guardar PDF</button>
        </aside>
      </section>

      <section className={`print-sheet material-print ${paper} ${palette}`} aria-label="Material visual para imprimir">
        <header className="print-header"><span>Mi Ciclo Listo · Material del aula</span><h1>{current.title} · {grade}</h1><p>{current.description}</p></header>
        <div className="print-visual-grid">
          {cards.map((card) => <article className="print-visual-card" key={card.id}><span className="card-icon" aria-hidden="true"><CardIcon id={card.id} label={card.label} /></span><strong>{card.label}</strong></article>)}
        </div>
        <footer className="print-footer">Material independiente de apoyo docente · Inovaris</footer>
      </section>
    </>
  );
}
