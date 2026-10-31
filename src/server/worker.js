// Cloudflare Worker: liefert das Spiel aus (Static Assets) und leitet
// WebSocket-Verbindungen an den passenden Game-Room (Durable Object) weiter.
export { GameRoom } from './room.js';

const ROOM_RE = /^\/api\/room\/([A-Za-z0-9]{3,12})\/ws$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, game: 'wormhouse' });
    }

    const m = url.pathname.match(ROOM_RE);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('WebSocket erwartet', { status: 426 });
      }
      const id = env.ROOMS.idFromName(m[1].toUpperCase());
      return env.ROOMS.get(id).fetch(request);
    }

    if (url.pathname.startsWith('/api/')) {
      return new Response('Nicht gefunden', { status: 404 });
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Nicht gefunden', { status: 404 });
  },
};
