// WebSocket-Verbindung zum Game-Room mit automatischem Reconnect.
export class Net {
  constructor(room, handlers) {
    this.room = room;
    this.handlers = handlers;
    this.queue = [];
    this.retry = 0;
    this.closed = false;
    this.connect();
  }

  connect() {
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
      if (this.closed) return;
      this.handlers.close?.();
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(obj) {
    const data = JSON.stringify(obj);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (obj.t !== 'snap' && obj.t !== 'fx') this.queue.push(data);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
