// Servidor para probar la página en la compu: node dev-server.js -> http://localhost:3000
// En Vercel no se usa: Vercel sirve index.html y api/data.js solo.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./api/data.js";

const raiz = path.dirname(fileURLToPath(import.meta.url));

http
  .createServer(async (req, res) => {
    if (req.url.startsWith("/api/data")) {
      let body = "";
      for await (const c of req) body += c;
      const r = {
        status(c) {
          res.statusCode = c;
          return r;
        },
        setHeader: (k, v) => res.setHeader(k, v),
        json(o) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(o));
        },
      };
      return handler({ method: req.method, headers: req.headers, body }, r);
    }
    const archivo = path.join(raiz, req.url === "/" ? "index.html" : req.url.split("?")[0]);
    if (!archivo.startsWith(raiz) || !fs.existsSync(archivo)) {
      res.statusCode = 404;
      return res.end("No encontrado");
    }
    res.setHeader("Content-Type", archivo.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
    fs.createReadStream(archivo).pipe(res);
  })
  .listen(3000, () => console.log("Caja del Fulbito en http://localhost:3000"));
