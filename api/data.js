// API de la página.
// GET  /api/data            -> todos los partidos con sus jugadores
// POST /api/data {accion}   -> guardar/borrar partidos, jugadores y videos
import { randomInt } from "node:crypto";
import {
  inicioPartido, MIN_ANTES_EQUIPOS, leerJugadores,
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
        const jug = { ...(body.jugador || {}), origen: pinOk ? "organizador" : "web" };
        // pagó también por otros: el monto tiene que alcanzar para todos y se reparte en partes iguales
        const lista = await leerJugadores(p.id);
        const otros = [...new Set(Array.isArray(body.otros) ? body.otros.map((x) => txt(x, 20)) : [])]
          .map((id) => lista.find((x) => x.id === id))
          .filter((x) => x && x.id !== jug.id && x.estado === "debe")
          .slice(0, 39);
        if (otros.length) {
          const total = Number(jug.monto) || 0;
          if (p.precio && total < p.precio * (otros.length + 1)) {
            return res.status(400).json({ error: `Con ${total.toLocaleString("es-AR")} no alcanza para ${otros.length + 1} (son ${(p.precio * (otros.length + 1)).toLocaleString("es-AR")}).` });
          }
          jug.monto = Math.round(total / (otros.length + 1));
        }
        const r = await guardarJugador(p, jug, { soloLista: !pinOk });
        for (const o of otros) {
          await guardarJugador(p, { id: o.id, nombre: o.nombre, estado: "pagado", metodo: jug.metodo, monto: jug.monto, origen: jug.origen, pagadoPor: r.jugador.nombre }, { soloLista: !pinOk });
        }
        return res.status(200).json({ ok: true, jugador: r.jugador, actualizado: r.actualizado, otros: otros.map((o) => o.nombre) });
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

      case "armarEquipos": {
        // cualquiera puede armarlos una vez: con la lista completa y desde 30 min antes. Mezclar de nuevo, solo el organizador.
        const p = await leerPartido(body.partidoId);
        if (!p) return res.status(404).json({ error: "Ese partido ya no existe." });
        const js = await leerJugadores(p.id);
        if (js.length < p.cupo) return res.status(409).json({ error: `${p.cupo - js.length === 1 ? "Falta" : "Faltan"} ${p.cupo - js.length} para completar los ${p.cupo}. Los equipos se arman con la lista completa.` });
        const desde = inicioPartido(p) - MIN_ANTES_EQUIPOS * 60e3;
        if (Date.now() < desde) {
          const hhmm = new Date(desde).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Argentina/Buenos_Aires" });
          return res.status(409).json({ error: `Los equipos se arman ${MIN_ANTES_EQUIPOS} minutos antes del partido, desde las ${hhmm}.` });
        }
        if (p.equipos && !pinOk) return res.status(409).json({ error: "Los equipos ya están armados. Solo el organizador puede mezclar de nuevo." });
        // si dos tocan a la vez, gana el primero
        if (!pinOk && !(await redis([["SET", `fulbito:armando:${p.id}`, "1", "NX", "EX", "15"]]))[0]) {
          return res.status(409).json({ error: "Alguien los está armando en este momento. Esperá unos segundos." });
        }
        const ids = js.map((j) => j.id);
        for (let i = ids.length - 1; i > 0; i--) { const k = randomInt(i + 1); [ids[i], ids[k]] = [ids[k], ids[i]]; }
        const mitad = Math.ceil(ids.length / 2);
        const fresco = (await leerPartido(p.id)) || p;
        if (fresco.equipos && !pinOk) return res.status(409).json({ error: "Los equipos ya están armados." });
        fresco.equipos = { a: ids.slice(0, mitad), b: ids.slice(mitad), armado: new Date().toISOString(), por: pinOk ? "organizador" : "web" };
        await redis([["HSET", K_PARTIDOS, p.id, JSON.stringify(fresco)]]);
        return res.status(200).json({ ok: true, partido: fresco });
      }

      case "sacarEquipos": {
        exigePin();
        const p = await leerPartido(body.partidoId);
        if (!p) return res.status(404).json({ error: "Ese partido ya no existe." });
        p.equipos = null;
        await redis([["HSET", K_PARTIDOS, p.id, JSON.stringify(p)]]);
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: "Acción desconocida." });
    }
  } catch (err) {
    if (!err.status) console.error(err);
    return res.status(err.status || 500).json({ error: err.status ? err.message : "Error del servidor. Probá de nuevo en un rato." });
  }
}
