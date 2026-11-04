// Datos de la Caja del Fulbito: lo comparten la página (api/data.js) y el bot de WhatsApp (api/whatsapp.js).
// Guarda en Upstash Redis (Vercel > Storage). Sin Redis configurado usa memoria (solo para probar en la compu).

const URL_REDIS = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_REDIS = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const K_PARTIDOS = "fulbito:partidos";
export const kJug = (pid) => `fulbito:jugadores:${pid}`;
export const almacenamiento = URL_REDIS ? "redis" : "memoria";

// ---------- Redis ----------
const memoria = new Map();

export async function redis(comandos) {
  if (!URL_REDIS) return comandos.map(memoriaCmd);
  const r = await fetch(`${URL_REDIS}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_REDIS}`, "Content-Type": "application/json" },
    body: JSON.stringify(comandos),
  });
  if (!r.ok) throw new Error(`Redis respondió ${r.status}`);
  const out = await r.json();
  return out.map((x) => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}

function memoriaCmd([cmd, key, ...args]) {
  if (cmd === "SET") {
    if (args.includes("NX") && memoria.has(key)) return null;
    memoria.set(key, args[0]);
    return "OK";
  }
  if (cmd === "GET") return typeof memoria.get(key) === "string" ? memoria.get(key) : null;
  if (cmd === "DEL") return memoria.delete(key) ? 1 : 0;
  const h = memoria.get(key) instanceof Map ? memoria.get(key) : new Map();
  memoria.set(key, h);
  switch (cmd) {
    case "HGETALL":
      return [...h.entries()].flat();
    case "HGET":
      return h.get(args[0]) ?? null;
    case "HSET":
      for (let i = 0; i < args.length; i += 2) h.set(args[i], args[i + 1]);
      return 1;
    case "HDEL":
      return args.reduce((n, f) => n + (h.delete(f) ? 1 : 0), 0);
    default:
      throw new Error("comando no soportado " + cmd);
  }
}

export const parHash = (arr) => {
  const out = [];
  for (let i = 0; i < (arr || []).length; i += 2) {
    try {
      out.push(JSON.parse(arr[i + 1]));
    } catch {}
  }
  return out;
};

// ---------- validación ----------
export const txt = (v, max = 80) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
export const num = (v, max = 10_000_000) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : 0;
};
export const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
export const pesos = (n) => "$" + Math.round(n || 0).toLocaleString("es-AR");
export const METODOS = ["mp", "banco", "efectivo"];
export const NOMBRE_METODO = { mp: "Mercado Pago", banco: "Banco", efectivo: "Efectivo" };

export class ErrorUsuario extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

// ---------- partidos ----------
export function limpiarPartido(p, previo = {}) {
  return {
    id: previo.id || txt(p.id, 20) || nuevoId(),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(p.fecha) ? p.fecha : previo.fecha || new Date().toISOString().slice(0, 10),
    hora: /^\d{2}:\d{2}$/.test(p.hora) ? p.hora : previo.hora || "21:00",
    cancha: txt(p.cancha ?? previo.cancha, 60),
    precio: num(p.precio ?? previo.precio),
    cupo: Math.max(2, Math.min(num(p.cupo ?? previo.cupo ?? 18, 40), 40)),
    resultado: txt(p.resultado ?? previo.resultado, 40),
    videos: previo.videos || [],
    creado: previo.creado || new Date().toISOString(),
  };
}

export async function leerPartido(pid) {
  const raw = (await redis([["HGET", K_PARTIDOS, txt(pid, 20)]]))[0];
  return raw ? JSON.parse(raw) : null;
}

export async function leerJugadores(pid) {
  return parHash((await redis([["HGETALL", kJug(pid)]]))[0]).sort((a, b) => a.creado.localeCompare(b.creado));
}

export async function leerTodo() {
  const partidos = parHash((await redis([["HGETALL", K_PARTIDOS]]))[0]).sort((a, b) =>
    (b.fecha + b.hora).localeCompare(a.fecha + a.hora),
  );
  const listas = partidos.length ? await redis(partidos.map((p) => ["HGETALL", kJug(p.id)])) : [];
  return partidos.map((p, i) => ({
    ...p,
    jugadores: parHash(listas[i]).sort((a, b) => a.creado.localeCompare(b.creado)),
  }));
}

/** El partido que está en juego: el próximo por jugarse, o si no hay, el último. */
export function partidoActual(partidos) {
  const limite = Date.now() - 6 * 3600e3; // hasta 6 h después de empezar sigue siendo "el actual"
  const futuros = partidos.filter((p) => new Date(`${p.fecha}T${p.hora}:00-03:00`).getTime() > limite);
  return futuros[futuros.length - 1] || partidos[0] || null;
}

/** Anota o actualiza un jugador. Si ya hay alguien con ese nombre, lo actualiza en vez de duplicar. */
export async function guardarJugador(p, j) {
  const nombre = txt(j.nombre, 40);
  if (!nombre) throw new ErrorUsuario("Falta el nombre.");
  const lista = await leerJugadores(p.id);
  const previo = lista.find((x) => x.id === j.id) || lista.find((x) => norm(x.nombre) === norm(nombre));
  if (!previo && lista.length >= p.cupo) throw new ErrorUsuario(`El partido está completo (${p.cupo} jugadores).`, 409);
  const pago = j.estado === "pagado";
  const nuevo = {
    id: previo?.id || nuevoId(),
    // si se encontró por nombre, respeta cómo estaba escrito
    nombre: previo && previo.id !== j.id ? previo.nombre : nombre,
    estado: pago ? "pagado" : "debe",
    metodo: pago ? (METODOS.includes(j.metodo) ? j.metodo : "efectivo") : null,
    monto: pago ? num(j.monto) || p.precio : 0,
    creado: previo?.creado || new Date().toISOString(),
    pagadoEn: pago ? (previo?.estado === "pagado" && previo.pagadoEn) || new Date().toISOString() : null,
    origen: txt(j.origen, 20) || previo?.origen || "web",
  };
  await redis([["HSET", kJug(p.id), nuevo.id, JSON.stringify(nuevo)]]);
  return { jugador: nuevo, actualizado: !!previo, yaPagado: previo?.estado === "pagado" };
}
