// API de la página.
// GET  /api/data            -> todos los partidos con sus jugadores
// POST /api/data {accion}   -> guardar/borrar partidos, jugadores y videos
import {
  redis, K_PARTIDOS, kJug, almacenamiento, txt, limpiarPartido, leerPartido, leerTodo, guardarJugador, cargarLista,
} from "../lib/store.js";

const PIN = (process.env.ADMIN_PIN || "").trim();
const BOT = (process.env.KAPSO_NUMERO || "").replace(/\D/g, ""); // número del bot, para mostrarlo en la página

function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      return res.status(200).json({ partidos: await leerTodo(), pinConfigurado: !!PIN, almacenamiento, bot: BOT || null });
    }
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
        // sin PIN solo se puede avisar que pagaste, y solo si estás en la lista
        const r = await guardarJugador(p, { ...(body.jugador || {}), origen: pinOk ? "organizador" : "web" }, { soloLista: !pinOk });
        return res.status(200).json({ ok: true, jugador: r.jugador, actualizado: r.actualizado });
      }

      case "cargarLista": {
        exigePin();
        const p = await leerPartido(body.partidoId);
        if (!p) return res.status(404).json({ error: "Ese partido ya no existe." });
        const nombres = String(body.nombres || "")
          .split(/[\n,;]+/)
          .map((s) => s.replace(/^\s*\d+\s*[.\-)]?\s*/, "").replace(/[✅❌💵⚽]/gu, "").trim())
          .filter(Boolean)
          .slice(0, 60);
        if (!nombres.length) return res.status(400).json({ error: "Pegá al menos un nombre." });
        const r = await cargarLista(p, nombres);
        return res.status(200).json({ ok: true, ...r });
      }

      case "borrarJugador": {
        exigePin();
        await redis([["HDEL", kJug(txt(body.partidoId, 20)), txt(body.id, 20)]]);
        return res.status(200).json({ ok: true });
      }

      case "agregarVideo": {
        exigePin();
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
