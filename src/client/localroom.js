// Einzelspieler & lokaler Hotseat ohne Server: Die Raum-Logik (sonst im Durable
// Object) läuft hier direkt im Browser. Dadurch geht das Spiel auch offline und
// ohne Netz-Latenz. LocalNet hat dieselbe Schnittstelle wie Net (send/suspend/
// resume/close), main.js merkt keinen Unterschied.
import { RoomLogic } from '../shared/room-logic.js';

export class LocalNet {
  constructor(room, handlers) {
    this.room = room;
    this.handlers = handlers;
    this.closed = false;
    this.local = true;
    let timer = 0;
    // Gegenstück zum Server-Socket: was der Raum „sendet“, landet asynchron im Client.
    const sock = {
      readyState: 1,
      att: null,
      send: (data) => {
        if (this.closed) return;
        queueMicrotask(() => {
          if (this.closed) return;
          let msg;
          try { msg = JSON.parse(data); } catch { return; }
          this.handlers.message?.(msg);
        });
      },
      serializeAttachment(a) { this.att = a; },
      deserializeAttachment() { return this.att; },
    };
    this.sock = sock;
    const ctx = {
      getWebSockets: () => (this.closed ? [] : [sock]),
      storage: {
        put: async () => {},
        get: async () => undefined,
        setAlarm: (at) => {
          clearTimeout(timer);
          timer = setTimeout(() => { if (!this.closed) this.logic.alarm(); }, Math.max(0, +at - Date.now()));
        },
        deleteAlarm: () => clearTimeout(timer),
      },
    };
    this.clearAlarm = () => clearTimeout(timer);
    this.logic = new RoomLogic(ctx);
    sock.serializeAttachment({ pid: null });
    queueMicrotask(() => { if (!this.closed) this.handlers.open?.(); });
  }

  send(obj) {
    if (this.closed) return;
    this.logic.webSocketMessage(this.sock, JSON.stringify(obj)).catch((err) => console.error(err));
  }

  // Handy gesperrt: hier gibt es niemanden, dem man den Zug übergeben müsste.
  // Beim Zurückkommen aber den Hänger-Wachhund beruhigen, sonst endet der Zug sofort.
  suspend() {}
  resume() {
    this.logic.lastSnapAt = Date.now();
  }

  close() {
    this.closed = true;
    this.clearAlarm();
  }
}
