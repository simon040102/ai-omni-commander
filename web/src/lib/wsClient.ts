export type WsMessageHandler = (msg: Record<string, unknown>) => void;

/**
 * WebSocket client with auto-reconnect and message queuing.
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageQueue: unknown[] = [];
  private _connected = false;

  constructor(
    private url: string,
    private onMessage: WsMessageHandler,
    private onConnectionChange?: (connected: boolean) => void,
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this._connected = true;
        this.onConnectionChange?.(true);

        // Flush queued messages
        for (const msg of this.messageQueue) {
          this.ws?.send(JSON.stringify(msg));
        }
        this.messageQueue = [];
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          this.onMessage(msg);
        } catch {
          console.warn('Invalid WebSocket message:', event.data);
        }
      };

      this.ws.onclose = () => {
        this._connected = false;
        this.onConnectionChange?.(false);

        // Auto-reconnect after 2s
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      };

      this.ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };
    } catch (err) {
      console.error('Failed to connect WebSocket:', err);
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    }
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.messageQueue.push(msg);
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // Prevent auto-reconnect
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }
}
