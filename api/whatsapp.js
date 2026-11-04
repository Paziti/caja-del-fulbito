// Bot de WhatsApp (vía Kapso): la gente le manda el comprobante por privado,
// Claude lo lee, lo anota en la Caja del Fulbito y contesta.
//
// Variables de entorno en Vercel:
//   KAPSO_API_KEY         clave del proyecto de Kapso
//   KAPSO_WEBHOOK_SECRET  la misma clave secreta que se pone al crear el webhook en Kapso
//   ANTHROPIC_API_KEY     clave de la API de Claude
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import Anthropic from "@anthropic-ai/sdk";
import {
  redis, leerTodo, leerJugadores, partidoActual, guardarJugador, norm, pesos, txt, num, NOMBRE_METODO, METODOS,
} from "../lib/store.js";

const KAPSO = "https://api.kapso.ai/meta/whatsapp/v24.0";
const API_KEY = process.env.KAPSO_API_KEY || "";
const SECRETO = process.env.KAPSO_WEBHOOK_SECRET || "";
const MODELO = process.env.MODELO || "claude-opus-5-5";
const MAX_ADJUNTO = 5 * 1024 * 1024; // límite de Claude para imágenes

// ---------- entrada HTTP ----------
export async function GET() {
  return Response.json({
    ok: true,
    configurado: { kapso: !!API_KEY, secreto: !!SECRETO, claude: !!process.env.ANTHROPIC_API_KEY },
  });
}

export async function POST(request) {
  const crudo = await request.text();
  if (!firmaValida(crudo, request.headers.get("x-webhook-signature"))) {
    return new Response("Firma inválida", { status: 401 });
  }
  let body;
  try {
    body = JSON.parse(crudo);
  } catch {
    return new Response("JSON inválido", { status: 400 });
  }
  const pagina = `https://${request.headers.get("host")}`;
  const mensajes = extraerMensajes(body);
  // Kapso espera respuesta en menos de 10 s: contestamos ya y procesamos después
  waitUntil(
    (async () => {
      for (const m of mensajes) {
        try {
          await procesar(m, pagina);
        } catch (err) {
          console.error("Error procesando mensaje", m.id, err);
          await enviar(m, "Uy, tuve un problema leyendo eso. Probá mandarlo de nuevo en un rato o avisale al organizador.").catch(() => {});
        }
      }
    })(),
  );
  return Response.json({ ok: true, recibidos: mensajes.length });
}

export function firmaValida(crudo, firma) {
  if (!SECRETO) return false; // sin secreto configurado no aceptamos nada
  if (typeof firma !== "string") return false;
  const esperado = Buffer.from(crypto.createHmac("sha256", SECRETO).update(crudo).digest("hex"));
  const recibido = Buffer.from(firma.replace(/^sha256=/, ""));
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
}

// Acepta el formato de Kapso (con o sin lote) y el formato de Meta
export function extraerMensajes(body) {
  const out = [];
  const agregar = (m, nombreContacto, phoneNumberId) => {
    if (!m || m.kapso?.direction === "outbound") return;
    const media = m.image || m.document || null;
    out.push({
      id: m.id,
      de: String(m.from || "").replace(/\D/g, ""),
      nombreContacto: txt(nombreContacto, 40),
      phoneNumberId,
      tipo: m.type,
      texto: txt(m.text?.body || media?.caption || m.button?.text || m.interactive?.button_reply?.title || "", 1000),
      mediaId: media?.id || null,
      mime: (media?.mime_type || m.kapso?.media_data?.content_type || "").split(";")[0],
    });
  };
  if (Array.isArray(body.entry)) {
    for (const e of body.entry)
      for (const c of e.changes || []) {
        const v = c.value || {};
        for (const m of v.messages || []) {
          const contacto = (v.contacts || []).find((x) => x.wa_id === m.from) || v.contacts?.[0];
          agregar(m, contacto?.profile?.name, v.metadata?.phone_number_id);
        }
      }
  }
  const items = Array.isArray(body.data) ? body.data : [body];
  for (const it of items) {
    if (it?.message) agregar(it.message, it.conversation?.contact_name, it.phone_number_id || it.conversation?.phone_number_id);
  }
  return out.filter((m) => m.id && m.de && m.phoneNumberId);
}

// ---------- Kapso ----------
async function enviar(m, texto) {
  const r = await fetch(`${KAPSO}/${m.phoneNumberId}/messages`, {
    method: "POST",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: m.de, type: "text", text: { body: texto.slice(0, 4000) } }),
  });
  if (!r.ok) console.error("Kapso no pudo enviar", r.status, await r.text().catch(() => ""));
}

async function descargar(m) {
  const info = await fetch(`${KAPSO}/${m.mediaId}?phone_number_id=${encodeURIComponent(m.phoneNumberId)}`, {
    headers: { "X-API-Key": API_KEY },
  });
  if (!info.ok) throw new Error(`No pude pedir el archivo (${info.status})`);
  const datos = await info.json();
  const archivo = await fetch(datos.download_url);
  if (!archivo.ok) throw new Error(`No pude bajar el archivo (${archivo.status})`);
  const buf = Buffer.from(await archivo.arrayBuffer());
  const mime = (datos.mime_type || m.mime || archivo.headers.get("content-type") || "").split(";")[0];
  return { buf, mime };
}

// ---------- lógica ----------
const kTel = "fulbito:telefonos"; // teléfono -> nombre en la lista
const kPend = (tel) => `fulbito:pendiente:${tel}`;
const kVisto = (id) => `fulbito:visto:${id}`;

async function procesar(m, pagina) {
  // Kapso reintenta si tardamos: no procesar dos veces el mismo mensaje
  const [nuevo] = await redis([["SET", kVisto(m.id), "1", "NX", "EX", "172800"]]);
  if (nuevo === null) return;

  const partidos = await leerTodo();
  const p = partidoActual(partidos);
  if (!p) return enviar(m, "Hola! Todavía no hay ningún partido cargado. Avisale al organizador que lo cree en la página.");

  const [conocido, pendRaw] = await redis([["HGET", kTel, m.de], ["GET", kPend(m.de)]]);
  const pendiente = pendRaw ? JSON.parse(pendRaw) : null;

  // adjunto (foto o PDF del comprobante)
  let adjunto = null;
  if (m.mediaId) {
    const esImagen = m.tipo === "image" || /^image\/(jpeg|png|webp|gif)$/.test(m.mime);
    const esPdf = m.mime === "application/pdf";
    if (!esImagen && !esPdf) return enviar(m, "Solo puedo leer fotos o PDF de comprobantes. Mandámelo así y lo anoto.");
    const { buf, mime } = await descargar(m);
    if (buf.length > MAX_ADJUNTO) return enviar(m, "El archivo es muy pesado. Mandame una captura de pantalla del comprobante.");
    adjunto = { data: buf.toString("base64"), mime: esPdf ? "application/pdf" : mime || "image/jpeg" };
  } else if (m.tipo === "audio") {
    return enviar(m, "No puedo escuchar audios 🙈 Escribime o mandame la foto del comprobante.");
  } else if (!m.texto) {
    return enviar(m, ayuda(p, pagina));
  }

  const r = await interpretar({ m, p, conocido, pendiente, adjunto });
  const canon = (nombre) => p.jugadores.find((j) => norm(j.nombre) === norm(nombre))?.nombre || txt(nombre, 40);

  if (!p.jugadores.length) {
    return enviar(m, "El organizador todavía no cargó la lista de este partido. Apenas la cargue, mandame el comprobante de nuevo.");
  }
  const enLista = (nombre) => p.jugadores.find((j) => norm(j.nombre) === norm(nombre));
  const debenTexto = () => p.jugadores.filter((j) => j.estado === "debe").map((j) => j.nombre).join(", ");

  // solo recordamos el teléfono si el nombre está en la lista del organizador
  let quien = conocido && enLista(conocido) ? enLista(conocido).nombre : null;
  if (r.nombre_remitente) {
    const j = enLista(r.nombre_remitente);
    if (j) {
      quien = j.nombre;
      await redis([["HSET", kTel, m.de, quien]]);
    } else if (r.intencion === "nombre") {
      return enviar(m, `No encuentro a "${txt(r.nombre_remitente, 40)}" en la lista 🤔 Mandame el nombre tal cual figura. Faltan pagar: ${debenTexto() || "nadie"}.`);
    }
  }

  // pagos de esta vez + los que esperaban saber de quién eran
  let pagos = r.pagos.map((x) => ({ ...x, jugador: x.jugador ? canon(x.jugador) : null }));
  if (pendiente && quien && (r.intencion === "nombre" || r.nombre_remitente)) {
    pagos = [...pendiente.map((x) => ({ ...x, jugador: x.jugador || quien })), ...pagos];
    await redis([["DEL", kPend(m.de)]]);
  }
  pagos = pagos.map((x) => ({ ...x, jugador: x.jugador || quien }));

  if (pagos.some((x) => !x.jugador)) {
    await redis([["SET", kPend(m.de), JSON.stringify(pagos), "EX", "86400"]]);
    const total = pagos.reduce((s, x) => s + (x.monto || 0), 0);
    return enviar(m, `Recibí el pago${total ? ` de ${pesos(total)}` : ""} 👍 ¿A nombre de quién lo anoto? Mandame el nombre como figura en la lista. Faltan pagar: ${debenTexto() || "nadie"}.`);
  }

  if (pagos.length) {
    const lineas = [];
    for (const x of pagos) {
      try {
        const g = await guardarJugador(p, {
          nombre: x.jugador,
          estado: "pagado",
          metodo: METODOS.includes(x.metodo) ? x.metodo : "mp",
          monto: num(x.monto) || p.precio,
          origen: "whatsapp",
        }, { soloLista: true });
        lineas.push(
          g.yaPagado
            ? `🔁 ${g.jugador.nombre} ya figuraba como pagado.`
            : `✅ Anotado: ${g.jugador.nombre}, ${NOMBRE_METODO[g.jugador.metodo]} ${pesos(g.jugador.monto)}.`,
        );
      } catch (err) {
        lineas.push(`⚠️ ${x.jugador}: ${err.status ? err.message : "no lo pude anotar, avisale al organizador."}`);
      }
    }
    const js = await leerJugadores(p.id);
    const pagaron = js.filter((j) => j.estado === "pagado").length;
    lineas.push(`Van ${pagaron}/${p.cupo} pagos. ${pagina}/#p-${p.id}`);
    if (r.duda) lineas.unshift(`🤔 ${r.duda}`);
    return enviar(m, lineas.join("\n"));
  }

  if (r.intencion === "consulta") return enviar(m, resumen(p, pagina));
  if (r.intencion === "nombre" && quien) return enviar(m, `Listo, ${quien}, te tengo agendado. Cuando pagues, mandame el comprobante por acá.`);
  return enviar(m, r.respuesta || ayuda(p, pagina));
}

function ayuda(p, pagina) {
  return [
    `Hola! Soy el bot de la Caja del Fulbito ⚽`,
    `Mandame por acá la foto o el PDF del comprobante y lo anoto solo. Si pagaste en efectivo, escribime "pagué en efectivo".`,
    `Para ver quién falta, escribime "lista".`,
    `Partido: ${fechaLarga(p)} ${p.hora} hs · ${pesos(p.precio)} c/u`,
    `${pagina}/#p-${p.id}`,
  ].join("\n");
}

function fechaLarga(p) {
  return new Date(p.fecha + "T12:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });
}

function resumen(p, pagina) {
  const pag = p.jugadores.filter((j) => j.estado === "pagado");
  const deben = p.jugadores.filter((j) => j.estado === "debe");
  const libres = p.cupo - p.jugadores.length;
  return [
    `⚽ ${fechaLarga(p)} · ${p.hora} hs`,
    `✅ Pagaron ${pag.length}/${p.cupo}: ${pag.map((j) => j.nombre).join(", ") || "nadie todavía"}`,
    deben.length ? `❌ Deben: ${deben.map((j) => j.nombre).join(", ")}` : "",
    libres > 0 ? `Quedan ${libres} lugares` : "",
    `${pagina}/#p-${p.id}`,
  ].filter(Boolean).join("\n");
}

// ---------- Claude ----------
const claude = new Anthropic();

const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intencion", "nombre_remitente", "pagos", "duda", "respuesta"],
  properties: {
    intencion: { type: "string", enum: ["pago", "nombre", "consulta", "otro"] },
    nombre_remitente: { type: ["string", "null"] },
    pagos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["jugador", "metodo", "monto"],
        properties: {
          jugador: { type: ["string", "null"] },
          metodo: { type: "string", enum: ["mp", "banco", "efectivo"] },
          monto: { type: ["number", "null"] },
        },
      },
    },
    duda: { type: ["string", "null"] },
    respuesta: { type: ["string", "null"] },
  },
};

const SISTEMA = `Sos el bot de WhatsApp que lleva la cuenta de quién pagó el fútbol de un grupo de amigos en Argentina.
La gente te escribe por privado. Te llega UN mensaje (texto, foto o PDF) y tenés que decidir qué significa.

intencion:
- "pago": manda un comprobante (Mercado Pago = "mp"; bancos, Ualá, Brubank, cuenta DNI, transferencias en general = "banco") o avisa que pagó en efectivo ("efectivo").
- "nombre": solo te está diciendo cómo se llama o a nombre de quién anotar un pago que quedó pendiente.
- "consulta": pregunta quién pagó, quién falta, cuánto es, la lista, etc.
- "otro": cualquier otra cosa (saludos, charla, fotos que no son comprobantes).

pagos (solo si intencion = "pago"):
- Un elemento por jugador. Si paga por varios ("pago lo mío y lo de Nico"), uno por cada uno repartiendo el monto.
- "jugador": el nombre EXACTO como figura en la lista si lo podés identificar. Si el pago es del propio remitente y ya sabés cómo figura en la lista (te lo paso como "Remitente en la lista"), usá ese nombre. Si no sabés quién es, poné null: el sistema le va a preguntar.
- El titular de la cuenta del comprobante puede ser un familiar o pareja: no lo uses como jugador salvo que coincida con alguien de la lista o con el remitente.
- "monto" en pesos como número, o null si no se ve.
- Si el comprobante parece de otra cosa (monto muy distinto al precio sin explicación, fecha de hace semanas), igual cargalo pero explicá en "duda" en una frase corta.

nombre_remitente: si en este mensaje el remitente dice cómo se llama (o es evidente por el contexto que te responde a "¿a nombre de quién?"), ponelo acá, preferentemente tal como figura en la lista. Si no, null.

respuesta: solo para intencion "otro": una respuesta corta y amable en castellano rioplatense, explicando que le mande el comprobante por acá. Si no, null.`;

async function interpretar({ m, p, conocido, pendiente, adjunto }) {
  const contenido = [];
  if (adjunto) {
    contenido.push(
      adjunto.mime === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: adjunto.data } }
        : { type: "image", source: { type: "base64", media_type: adjunto.mime, data: adjunto.data } },
    );
  }
  const lista = p.jugadores.length
    ? p.jugadores.map((j) => `${j.nombre} (${j.estado === "pagado" ? "pagó" : "debe"})`).join(", ")
    : "(nadie anotado todavía: cualquier nombre es válido)";
  contenido.push({
    type: "text",
    text: [
      `Hoy: ${new Date().toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}`,
      `Partido: ${p.fecha} ${p.hora} hs · precio por persona ${pesos(p.precio)} · cupo ${p.cupo}`,
      `Lista: ${lista}`,
      `Nombre de WhatsApp del remitente: ${m.nombreContacto || "(desconocido)"}`,
      `Remitente en la lista: ${conocido || "(todavía no sé quién es)"}`,
      pendiente ? `Pago pendiente de este remitente esperando que diga a nombre de quién: ${JSON.stringify(pendiente)}` : "",
      `\nMENSAJE${adjunto ? " (adjunta " + (adjunto.mime === "application/pdf" ? "un PDF" : "una foto") + ")" : ""}:`,
      m.texto || "(sin texto)",
    ].filter(Boolean).join("\n"),
  });

  const resp = await claude.beta.messages.create({
    model: MODELO,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
    system: SISTEMA,
    messages: [{ role: "user", content: contenido }],
  });
  if (resp.stop_reason === "refusal") return { intencion: "otro", nombre_remitente: null, pagos: [], duda: null, respuesta: null };
  const bloque = resp.content.find((b) => b.type === "text");
  return JSON.parse(bloque.text);
}
