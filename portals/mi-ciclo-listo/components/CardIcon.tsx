type Props = { id: string; label: string };

const groups = {
  book: new Set(["cuento", "libros", "biblioteca", "trabajos"]),
  pencil: new Set(["actividad", "material", "arte", "ciencia"]),
  home: new Set(["entrada", "salida", "areas", "construccion", "juego"]),
  drop: new Set(["lavado", "plantas", "agua", "lluvia"]),
  basket: new Set(["guardar", "materiales", "mesa", "reciclaje", "guardo"]),
  hand: new Set(["fila", "escucho", "espero", "camino", "ayuda", "porfavor", "permiso", "turno", "ayudas", "presto"]),
  heart: new Set(["saludo", "cuidado", "gracias", "gusta", "acuerdo"]),
};

const emotionIds = new Set(["alegre", "tranquilo", "triste", "enojado", "miedo", "cansado", "emocionado", "confundido"]);

export function CardIcon({ id, label }: Props) {
  if (id.startsWith("n-")) return <b className="number-icon">{label}</b>;

  if (emotionIds.has(id)) {
    const mouth = id === "alegre" || id === "emocionado" ? "M8 14c2 3 6 3 8 0" : id === "triste" || id === "miedo" ? "M8 17c2-3 6-3 8 0" : "M8 16h8";
    return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M9 9h.01M15 9h.01" /><path d={mouth} /></svg>;
  }

  if (id === "soleado" || id === "patio") return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2" /></svg>;
  if (id === "nublado") return <svg viewBox="0 0 24 24"><path d="M6 18h12a4 4 0 0 0 0-8 6 6 0 0 0-11-1A4.5 4.5 0 0 0 6 18Z" /></svg>;
  if (id === "viento") return <svg viewBox="0 0 24 24"><path d="M3 8h12c4 0 4-5 1-5-2 0-3 1-3 2M3 12h16c3 0 3 4 0 4h-2M3 16h9" /></svg>;
  if (id === "frio") return <svg viewBox="0 0 24 24"><path d="M12 2v20M4 7l16 10M4 17 20 7M8 4l4 3 4-3M8 20l4-3 4 3" /></svg>;
  if (id === "calor") return <svg viewBox="0 0 24 24"><path d="M10 4a2 2 0 0 1 4 0v9a5 5 0 1 1-4 0Z" /><path d="M12 8v8" /></svg>;
  if (groups.book.has(id)) return <svg viewBox="0 0 24 24"><path d="M3 5c4-1 7 0 9 2v13c-2-2-5-3-9-2Zm18 0c-4-1-7 0-9 2v13c2-2 5-3 9-2Z" /></svg>;
  if (groups.pencil.has(id)) return <svg viewBox="0 0 24 24"><path d="m5 18 12-12 3 3L8 21H5Zm9-9 3 3M4 5h7" /></svg>;
  if (groups.home.has(id)) return <svg viewBox="0 0 24 24"><path d="m3 11 9-8 9 8M6 9v11h12V9m-8 11v-6h4v6" /></svg>;
  if (groups.drop.has(id)) return <svg viewBox="0 0 24 24"><path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z" /><path d="M9 15c.5 1.5 1.5 2 3 2" /></svg>;
  if (groups.basket.has(id)) return <svg viewBox="0 0 24 24"><path d="M4 9h16l-2 11H6Zm4 0 4-6 4 6M9 13v4m3-4v4m3-4v4" /></svg>;
  if (groups.hand.has(id)) return <svg viewBox="0 0 24 24"><path d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v7l1-2a1.7 1.7 0 0 1 3 2l-3 6a5 5 0 0 1-4 2h-3a6 6 0 0 1-6-6v-3a1.5 1.5 0 0 1 3 0Z" /></svg>;
  if (groups.heart.has(id)) return <svg viewBox="0 0 24 24"><path d="M12 20S4 15 4 9a4 4 0 0 1 7-3l1 1 1-1a4 4 0 0 1 7 3c0 6-8 11-8 11Z" /></svg>;
  if (id === "circulo" || id === "calendario") return <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4m8-4v4M4 10h16M8 14h3m2 0h3" /></svg>;
  if (id === "voz") return <svg viewBox="0 0 24 24"><path d="M5 14h4l5 4V6l-5 4H5Zm12-5c2 2 2 4 0 6m2-9c4 4 4 8 0 12" /></svg>;
  return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M8 12h8M12 8v8" /></svg>;
}
