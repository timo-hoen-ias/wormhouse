// WebSocket-Verbindung zum Game-Room mit automatischem Reconnect.
export class Net {
  constructor(room, handlers) {
    this.room = room;
    this.handlers = handlers;
    this.queue = [];
    this.retry = 0;
    this.closed = false;
    // Netz wieder da (z.B. aus dem Funkloch zurück): sofort neu verbinden statt Backoff abzuwarten.
    this.onOnline = () => { this.retry = 0; this.connect(); };
    window.addEventListener('online', this.onOnline);
    this.connect();
  }

  connect() {
    if (this.closed || this.suspended) return;
    if (this.ws && this.ws.readyState <= 1) return; // verbindet schon / ist verbunden
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/room/${encodeURIComponent(this.room)}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.handlers.open?.();
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.handlers.message?.(msg);
    };
    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return;
      this.handlers.close?.();
      this.ws = null;
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(obj) {
    const data = JSON.stringify(obj);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (obj.t !== 'snap' && obj.t !== 'fx') this.queue.push(data);
  }

  // Handy gesperrt / App gewechselt: Verbindung bewusst trennen, damit der Server
  // sofort Bescheid weiß (Zug weitergeben, Schichtleitung übergeben), statt eine
  // eingefrorene Verbindung für lebendig zu halten.
  suspend() {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* egal */ }
  }

  // Zurück im Vordergrund: frisch verbinden (die alte Verbindung kann halb tot sein).
  resume() {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    this.retry = 0;
    this.connect();
  }

  close() {
    this.closed = true;
    window.removeEventListener('online', this.onOnline);
    this.ws?.close();
  }
}
