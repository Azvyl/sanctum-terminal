import { ConfigManager } from "./config.ts";

export const Log = {
  debug: (tag: string, msg: string, data?: unknown) => {
    if (!ConfigManager.IS_DEBUG) return;
    const dataStr = data !== undefined ? (typeof data === "object" ? ` ${JSON.stringify(data)}` : ` ${data}`) : "";
    console.log(`%c[DEBUG] [${new Date().toLocaleTimeString()}] [${tag}] ${msg}${dataStr}`, "color: #888888; font-style: italic");
  },

  info: (tag: string, msg: string, data?: unknown) => {
    const dataStr = data !== undefined ? (typeof data === "object" ? ` ${JSON.stringify(data)}` : ` ${data}`) : "";
    console.log(`%c[INFO]  [${new Date().toLocaleTimeString()}] [${tag}] ${msg}${dataStr}`, "color: #3b82f6; font-weight: bold");
  },

  success: (tag: string, msg: string, data?: unknown) => {
    const dataStr = data !== undefined ? (typeof data === "object" ? ` ${JSON.stringify(data)}` : ` ${data}`) : "";
    console.log(`%c[OK]    [${new Date().toLocaleTimeString()}] [${tag}] ${msg}${dataStr}`, "color: #10b981; font-weight: bold");
  },

  warn: (tag: string, msg: string, data?: unknown) => {
    const dataStr = data !== undefined ? (typeof data === "object" ? ` ${JSON.stringify(data)}` : ` ${data}`) : "";
    console.log(`%c[WARN]  [${new Date().toLocaleTimeString()}] [${tag}] ${msg}${dataStr}`, "color: #f59e0b; font-weight: bold");
  },

  error: (tag: string, msg: string, err?: unknown) => {
    console.error(`%c[ERROR] [${new Date().toLocaleTimeString()}] [${tag}] ${msg}`, "color: #ef4444; font-weight: bold", err !== undefined ? err : "");
  },

  banner: (nodeId: string, nodeName?: string) => {
    console.log("%c==================================================================", "color: #a855f7; font-weight: bold");
    console.log("%c   SCHALE CENTRAL SYSTEM - SANCTUM TERMINAL ENGINE", "color: #10b981; font-weight: bold");
    console.log(`%c   NODE ID   : ${nodeId.toUpperCase()}`, "color: #f59e0b; font-weight: bold");
    if (nodeName && nodeName !== nodeId) {
      console.log(`%c   NODE NAME : ${nodeName}`, "color: #3b82f6; font-weight: bold");
    }
    console.log("%c==================================================================", "color: #a855f7");
  },


  cli: (msg: string = "") => {
    console.log(msg);
  },
};
