import type { TaskStatus } from "../tasks/types.ts";

export interface SubscribeMessage {
  type: "subscribe";
  taskId: string;
}

export type WsInboundMessage = SubscribeMessage;

export type WsOutboundMessage =
  | { type: "progress"; taskId: string; progress: number }
  | { type: "completed"; taskId: string }
  | { type: "failed"; taskId: string }
  | { type: "state"; taskId: string; status: TaskStatus; progress: number };
