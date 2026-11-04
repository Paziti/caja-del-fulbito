# Caja del Fulbito

Página para llevar quién pagó el fútbol, en vivo. Cada uno entra desde el link, pone su nombre y si pagó (Mercado Pago, banco o efectivo). La página muestra el tablero con lo recaudado, la cancha con los 18 lugares, gráficos, la tabla de deudores de todas las fechas y los videos de YouTube del partido.

## Publicarla en Vercel (una sola vez)

1. Entrá a https://vercel.com, iniciá sesión con GitHub y tocá **Add New → Project**. Elegí este repositorio y tocá **Deploy**. No hace falta cambiar nada.
2. En el proyecto, andá a **Storage → Create Database → Upstash (Redis)**, elegí el plan gratis y conectalo al proyecto. Vercel agrega solo las claves (`KV_REST_API_URL` y `KV_REST_API_TOKEN`).
3. En **Settings → Environment Variables** agregá `ADMIN_PIN` con un número que solo sepa el organizador (por ejemplo `4821`).
4. Andá a **Deployments**, tocá los tres puntos del último y **Redeploy**, para que tome la base de datos y el PIN.

Listo: el link que te da Vercel (algo como `caja-del-fulbito.vercel.app`) es el que se manda al grupo.

## Uso semanal

- El organizador entra, abajo de todo pone el PIN y crea el partido (fecha, hora, cancha, precio, cupo). La fecha siguiente se completa sola con una semana más.
- Con **Copiar link** se manda al grupo. Cada uno se anota y avisa cómo pagó.
- Los que pagan en mano: el organizador toca **MP / Banco / Efvo** en la fila de cada uno.
- **Copiar resumen** arma el mensaje para WhatsApp con quién pagó y quién debe.
- Sin PIN se puede: anotarse, marcar pagos, editar y subir videos. Con PIN: crear, editar y borrar partidos, borrar jugadores y videos.

## Probar en la compu

```
node dev-server.js
```

y abrí http://localhost:3000. Sin Upstash configurado guarda todo en memoria (se borra al cerrar).
