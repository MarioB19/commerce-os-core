"use client";

import { useEffect, useMemo, useState } from "react";
import { gradeLabels, gradeLevel, getPrimaryProfile } from "@/lib/grade-profiles";

const STORAGE_KEY = "mcl:kit-grupo:v1";
const recognitions = [
  "Por su curiosidad", "Por compartir sus ideas", "Por cuidar a los demás", "Por intentarlo de nuevo",
  "Por trabajar en equipo", "Por escuchar con atención", "Por expresar lo que siente", "Por su creatividad",
  "Por cuidar los materiales", "Por hacer preguntas", "Por ayudar al grupo", "Por celebrar sus avances",
];

type Student = { id: string; name: string; recognition: string };
type MaterialType = "diploma" | "medalla" | "pasaporte";
type Saved = { version: 1; grade?: string; teacher: string; group: string; students: Student[]; material: MaterialType; paper: "letter" | "a4" };

const uid = () => globalThis.crypto?.randomUUID?.() || `alumno-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function StudentPiece({ student, material, advances }: { student: Student; material: MaterialType; advances: string[] }) {
  return (
    <article className={`student-piece ${student.name.length > 55 ? "very-long-name" : student.name.length > 28 ? "long-name" : ""}`}>
      <div className="piece-flower" aria-hidden="true">✶</div>
      {material === "diploma" && <p className="piece-kicker">Diploma para</p>}
      {material === "medalla" && <p className="piece-kicker">Medalla de logro</p>}
      {material === "pasaporte" && <p className="piece-kicker">Pasaporte de avances</p>}
      <h2>{student.name}</h2>
      {material !== "pasaporte" && <p className="piece-recognition">{student.recognition}</p>}
      {material === "diploma" && <div className="signature-line">Firma de la docente</div>}
      {material === "pasaporte" && <div className="passport-grid">{advances.map((advance) => <span key={advance}>{advance}<br />Fecha: ______</span>)}</div>}
      <small>Mi Ciclo Listo · Material independiente</small>
    </article>
  );
}

export function GroupKitTool() {
  const [grade, setGrade] = useState("");
  const [level, setLevel] = useState("");
  const profile = getPrimaryProfile(grade);
  const advances = profile?.advances ?? ["Comunico mis ideas", "Exploro cantidades", "Cuido mi entorno", "Participo con otros", "Pido apoyo", "Reconozco un avance"];
  const gradeRecognitions = profile ? profile.advances.map((value) => `Por su avance: ${value.toLocaleLowerCase("es")}`) : recognitions;
  const [teacher, setTeacher] = useState("");
  const [group, setGroup] = useState("");
  const [names, setNames] = useState("");
  const [students, setStudents] = useState<Student[]>([]);
  const [material, setMaterial] = useState<MaterialType>("diploma");
  const [paper, setPaper] = useState<"letter" | "a4">("letter");
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null") as Saved | null;
        if (saved?.version === 1) {
          const savedGrade = saved.grade === undefined ? "1.º de preescolar" : gradeLabels.includes(saved.grade) ? saved.grade : "";
          setGrade(savedGrade); setLevel(gradeLevel(savedGrade));
          setTeacher(saved.teacher || ""); setGroup(saved.group || "");
          setStudents(Array.isArray(saved.students) ? saved.students.slice(0, 40) : []);
          setMaterial(["diploma", "medalla", "pasaporte"].includes(saved.material) ? saved.material : "diploma");
          setPaper(saved.paper === "a4" ? "a4" : "letter");
        }
      } catch { sessionStorage.removeItem(STORAGE_KEY); }
      setHydrated(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const value: Saved = { version: 1, grade, teacher, group, students, material, paper };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }, [grade, group, hydrated, material, paper, students, teacher]);

  const complete = useMemo(
    () => !grade ? [] : students.filter(({ name, recognition }) => name.trim() && (material === "pasaporte" || recognition)),
    [grade, material, students],
  );

  function addNames() {
    const parsed = names.split(/\n|,/).map((name) => name.trim()).filter(Boolean);
    const available = Math.max(0, 40 - students.length);
    if (!parsed.length) { setMessage("Escribe al menos un nombre."); return; }
    setStudents((current) => [...current, ...parsed.slice(0, available).map((name) => ({ id: uid(), name, recognition: "" }))]);
    setNames("");
    setMessage(parsed.length > available ? `Agregamos ${available}; el máximo es 40.` : material === "pasaporte" ? "Nombres agregados. Revisa los datos y la vista previa." : "Nombres agregados. Ahora decide cada reconocimiento.");
  }

  function update(id: string, patch: Partial<Student>) {
    setStudents((current) => current.map((student) => student.id === id ? { ...student, ...patch } : student));
  }

  function clearAll() {
    if (!window.confirm("¿Borrar nombres, reconocimientos y datos de esta sesión?")) return;
    sessionStorage.removeItem(STORAGE_KEY); setGrade(""); setLevel(""); setTeacher(""); setGroup(""); setNames(""); setStudents([]); setMaterial("diploma"); setPaper("letter"); setMessage("Datos de esta sesión borrados.");
  }

  return (
    <>
      <style>{`@media print { @page { size: ${paper === "a4" ? "A4" : "letter"}; margin: 10mm; } }`}</style>
      <section className="builder-shell kit-shell">
        <aside className="filter-panel no-print">
          <span className="eyebrow">Kit del grupo</span><h1>Reconoce con intención</h1>
          <p className="panel-intro">Diplomas, medallas y pasaportes. La herramienta nunca decide qué logro recibe una niña o un niño.</p>
          <label htmlFor="kit-level">Nivel</label><select id="kit-level" value={level} onChange={(event) => { setLevel(event.target.value); setGrade(""); setStudents((current) => current.map((student) => ({ ...student, recognition: "" }))); }}><option value="">Elige un nivel</option><option value="preescolar">Preescolar</option><option value="primaria">Primaria</option></select>
          <label htmlFor="kit-grade">Grado</label><select id="kit-grade" disabled={!level} value={grade} onChange={(event) => { setGrade(event.target.value); setStudents((current) => current.map((student) => ({ ...student, recognition: "" }))); }}><option value="">Elige un grado</option>{gradeLabels.filter((g) => gradeLevel(g) === level).map((g) => <option key={g}>{g}</option>)}</select>
          <label htmlFor="teacher">Nombre de la docente</label><input id="teacher" value={teacher} onChange={(event) => setTeacher(event.target.value)} maxLength={80} />
          <label htmlFor="group">Grupo</label><input id="group" value={group} onChange={(event) => setGroup(event.target.value)} placeholder="Ej. 2.º A" maxLength={40} />
          <label htmlFor="material">Formato</label>
          <select id="material" value={material} onChange={(event) => setMaterial(event.target.value as MaterialType)}>
            <option value="diploma">Diplomas</option><option value="medalla">Medallas de logro</option><option value="pasaporte">Pasaportes de avances</option>
          </select>
          <label htmlFor="paper-kit">Papel</label><select id="paper-kit" value={paper} onChange={(event) => setPaper(event.target.value as "letter" | "a4")}><option value="letter">Carta</option><option value="a4">A4</option></select>
          <button className="danger-link" type="button" onClick={clearAll}>Borrar datos de este navegador</button>
          <p className="local-note">Guardado solo durante esta sesión · versión 1</p>
        </aside>

        <div className="kit-editor no-print">
          <div className="results-heading"><div><span className="eyebrow">Tu lista</span><h2>Agrega hasta 40 nombres</h2></div><strong>{students.length}/40</strong></div>
          <label htmlFor="names">Un nombre por línea</label>
          <textarea id="names" value={names} onChange={(event) => setNames(event.target.value)} rows={5} placeholder={"Mariana\nLuis\nSofía"} />
          <button className="button" type="button" onClick={addNames} disabled={students.length >= 40}>Agregar nombres</button>
          {message && <p className="tool-message" role="status">{message}</p>}

          <div className="student-list">
            {students.map((student, index) => (
              <div className="student-row" key={student.id}>
                <span>{index + 1}</span>
                <label><span className="sr-only">Nombre {index + 1}</span><input value={student.name} onChange={(event) => update(student.id, { name: event.target.value })} maxLength={100} /></label>
                {material !== "pasaporte" ? (
                  <label><span className="sr-only">Reconocimiento para {student.name}</span><select value={student.recognition} onChange={(event) => update(student.id, { recognition: event.target.value })}><option value="">Elige de forma intencional…</option>{gradeRecognitions.map((item) => <option key={item}>{item}</option>)}</select></label>
                ) : <span className="quiet">Se imprime con espacios para registrar avances</span>}
                <button className="icon-danger" type="button" onClick={() => setStudents((current) => current.filter(({ id }) => id !== student.id))} aria-label={`Quitar a ${student.name || `alumno ${index + 1}`}`}>×</button>
              </div>
            ))}
            {!students.length && <div className="empty-state small"><span aria-hidden="true">+</span><h3>Tu grupo aparecerá aquí</h3></div>}
          </div>
        </div>

        <aside className="selection-panel no-print">
          <span className="eyebrow">Vista final</span><h2>{complete.length} piezas listas</h2>
          {material !== "pasaporte" && students.length !== complete.length && <p className="notice compact">Falta elegir {students.length - complete.length} {students.length - complete.length === 1 ? "logro" : "logros"}. No completamos etiquetas automáticamente.</p>}
          <p className="quiet">Los nombres largos reducen su tamaño automáticamente. Revisa la vista de impresión antes de guardar.</p>
          {complete.length > 0 && <div className={`kit-screen-preview ${material}`} aria-label="Vista previa de la primera pieza"><StudentPiece student={complete[0]} material={material} advances={advances} /></div>}
          <button className="button button-wide" type="button" disabled={!complete.length} onClick={() => window.print()}>Imprimir / guardar PDF</button>
        </aside>
      </section>

      <section className={`print-sheet kit-print ${paper}`} aria-label="Kit de grupo para imprimir">
        <header className="print-header"><span>Mi Ciclo Listo · Kit del grupo</span><p>{grade} · {group}{teacher ? ` · Docente: ${teacher}` : ""}</p></header>
        <div className={`kit-print-grid ${material}`}>
          {complete.map((student) => <StudentPiece key={student.id} student={student} material={material} advances={advances} />)}
        </div>
      </section>
    </>
  );
}
