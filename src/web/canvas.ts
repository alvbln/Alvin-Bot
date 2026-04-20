import { WebSocket } from "ws";

const canvasClients = new Set<WebSocket>();

export function addCanvasClient(ws: WebSocket): void {
  canvasClients.add(ws);
  ws.on("close", () => canvasClients.delete(ws));
}

export function canvasPresent(html: string): void {
  const msg = JSON.stringify({ type: "present", html });
  for (const ws of canvasClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function canvasEval(js: string): void {
  const msg = JSON.stringify({ type: "eval", js });
  for (const ws of canvasClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function canvasClear(): void {
  const msg = JSON.stringify({ type: "clear" });
  for (const ws of canvasClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function getCanvasClientCount(): number {
  return canvasClients.size;
}
