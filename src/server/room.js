// Ein Spielraum = ein Durable Object. Die eigentliche Logik steckt plattform-
// unabhängig in src/shared/room-logic.js (läuft für Einzelspieler auch im Browser).
import { DurableObject } from 'cloudflare:workers';
import { RoomLogic } from '../shared/room-logic.js';

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.logic = new RoomLogic(ctx);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('state');
      const live = new Set(ctx.getWebSockets().map((ws) => ws.deserializeAttachment()?.pid));
      this.logic.restore(saved, live);
    });
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) { return this.logic.webSocketMessage(ws, raw); }
  webSocketClose(ws) { return this.logic.handleLeave(ws); }
  webSocketError(ws) { return this.logic.handleLeave(ws); }
  alarm() { return this.logic.alarm(); }
}
