// API de la Caja del Fulbito.
// GET  /api/data            -> todos los partidos con sus jugadores
// POST /api/data {accion}   -> guardar/borrar partidos, jugadores y videos
//
// Guarda los datos en Upstash Redis (se conecta desde Vercel > Storage).
// Sin Redis configurado usa memoria (solo sirve para probar en la compu).

const URL_REDIS = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_REDIS = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PIN = (process.env.ADMIN_PIN || "").trim();
const K_PARTIDOS = "fulbito:partidos";
const kJug = (pid) => `fulbito:jugadores:${pid}`;

// ---------- almacenamiento ----------
const memoria = new Map();

async function redis(comandos) {
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
  const h = memoria.get(key) || new Map();
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
    case "DEL":
      memoria.delete(key);
      return 1;
    default:
      throw new Error("comando no soportado " + cmd);
  }
}

const parHash = (arr) => {
  const out = [];
  for (let i = 0; i < (arr || []).length; i += 2) {
    try {
      out.push(JSON.parse(arr[i + 1]));
    } catch {}
  }
  return out;
};

// ---------- validación ----------
const txt = (v, max = 80) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const num = (v, max = 10_000_000) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : 0;
};
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const METODOS = ["mp", "banco", "efectivo"];

function limpiarPartido(p, previo = {}) {
  return {
    id: previo.id || txt(p.id, 20) || id(),
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

function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") return res.status(200).json(await leerTodo());
    if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const pinOk = !PIN || String(req.headers["x-pin"] || "") === PIN;
    const exigePin = () => {
      if (!pinOk) {
        const e = new Error("Esta acción es solo para el organizador. Activá el modo organizador con el PIN.");
        e.status = 403;
        throw e;
      }
    };

    switch (body.accion) {
      case "verificarPin":
        return res.status(pinOk ? 200 : 403).json({ ok: pinOk, pinConfigurado: !!PIN });

      case "guardarPartido": {
        exigePin();
        const previo = body.partido?.id ? await leerPartido(body.partido.id) : null;
        const p = limpiarPartido(body.partido || {}, previo || {});
        await redis([["HSET", K_PARTIDOS, p.id, JSON.stringify(p)]]);
        return res.status(200).json({ ok: true, partido: p });
      }

      case "borrarPartido": {
        exigePin();
        await redis([["HDEL", K_PARTIDOS, txt(body.id, 20)], ["DEL", kJug(txt(body.id, 20))]]);
        return res.status(200).json({ ok: true });
      }

      case "guardarJugador": {
        const p = await leerPartido(body.partidoId);
        if (!p) return res.status(404).json({ error: "Ese partido ya no existe." });
        const j = body.jugador || {};
        const nombre = txt(j.nombre, 40);
        if (!nombre) return res.status(400).json({ error: "Falta el nombre." });

        const lista = parHash((await redis([["HGETALL", kJug(p.id)]]))[0]);
        // Si ya hay alguien con ese nombre, se actualiza en vez de duplicar
        const previo = lista.find((x) => x.id === j.id) || lista.find((x) => norm(x.nombre) === norm(nombre));
        if (!previo && lista.length >= p.cupo) {
          return res.status(409).json({ error: `El partido está completo (${p.cupo} jugadores).` });
        }
        const pago = j.estado === "pagado";
        const nuevo = {
          id: previo?.id || id(),
          // si se encontró por nombre, respeta cómo estaba escrito
          nombre: previo && previo.id !== j.id ? previo.nombre : nombre,
          estado: pago ? "pagado" : "debe",
          metodo: pago ? (METODOS.includes(j.metodo) ? j.metodo : "efectivo") : null,
          monto: pago ? num(j.monto) || p.precio : 0,
          creado: previo?.creado || new Date().toISOString(),
          pagadoEn: pago ? (previo?.estado === "pagado" && previo.pagadoEn) || new Date().toISOString() : null,
        };
        await redis([["HSET", kJug(p.id), nuevo.id, JSON.stringify(nuevo)]]);
        return res.status(200).json({ ok: true, jugador: nuevo, actualizado: !!previo });
      }

      case "borrarJugador": {
        exigePin();
        await redis([["HDEL", kJug(txt(body.partidoId, 20)), txt(body.id, 20)]]);
        return res.status(200).json({ ok: true });
      }

      case "agregarVideo": {
        const p = await leerPartido(body.partidoId);
        if (!p) return res.status(404).json({ error: "Ese partido ya no existe." });
        const yt = youtubeId(body.url);
        if (!yt) return res.status(400).json({ error: "No reconozco ese link. Pegá un link de YouTube." });
        if (p.videos.length >= 20) return res.status(409).json({ error: "Ya hay 20 videos en este partido." });
        p.videos = [...p.videos.filter((v) => v.yt !== yt), { yt, titulo: txt(body.titulo, 60) || "Partido completo", creado: new Date().toISOString() }];
        await redis([["HSET", K_PARTIDOS, p.id, JSON.stringify(p)]]);
        return res.status(200).json({ ok: true, partido: p });
      }

      case "borrarVideo": {
        exigePin();
        const p = await leerPartido(body.partidoId);
        if (!p) return res.status(404).json({ error: "Ese partido ya no existe." });
        p.videos = p.videos.filter((v) => v.yt !== body.yt);
        await redis([["HSET", K_PARTIDOS, p.id, JSON.stringify(p)]]);
        return res.status(200).json({ ok: true, partido: p });
      }

      default:
        return res.status(400).json({ error: "Acción desconocida." });
    }
  } catch (err) {
    if (!err.status) console.error(err);
    return res.status(err.status || 500).json({ error: err.status ? err.message : "Error del servidor. Probá de nuevo en un rato." });
  }
}

async function leerPartido(pid) {
  const raw = (await redis([["HGET", K_PARTIDOS, txt(pid, 20)]]))[0];
  return raw ? JSON.parse(raw) : null;
}

async function leerTodo() {
  const partidos = parHash((await redis([["HGETALL", K_PARTIDOS]]))[0]).sort((a, b) =>
    (b.fecha + b.hora).localeCompare(a.fecha + a.hora),
  );
  const listas = partidos.length ? await redis(partidos.map((p) => ["HGETALL", kJug(p.id)])) : [];
  return {
    partidos: partidos.map((p, i) => ({
      ...p,
      jugadores: parHash(listas[i]).sort((a, b) => a.creado.localeCompare(b.creado)),
    })),
    pinConfigurado: !!PIN,
    almacenamiento: URL_REDIS ? "redis" : "memoria",
  };
}
