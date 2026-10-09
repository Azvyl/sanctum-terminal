import { ParsedSocialStreamMessage, SocialStreamPayload } from "./types.ts";

export class SocialStreamPayloadParser {
  static sanitizeChatMessage(rawMsg: string): string {
    if (!rawMsg) return "";
    return rawMsg
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .trim();
  }

  static extractUsername(payload: SocialStreamPayload): string {
    return (
      payload.chatname ||
      payload.username ||
      payload.sourceName ||
      "Unknown"
    ).trim();
  }

  static extractPlatform(payload: SocialStreamPayload): string {
    const rawPlatform = payload.type || payload.platform || payload.source || "YouTube";
    return rawPlatform.trim();
  }

  static parse(payload: SocialStreamPayload): ParsedSocialStreamMessage | null {
    if (!payload || typeof payload !== "object") return null;

    const rawMsg = payload.chatmessage;
    if (typeof rawMsg !== "string" || !rawMsg.trim()) {
      return null;
    }

    const username = this.extractUsername(payload);
    const platform = this.extractPlatform(payload);
    const cleanMessage = this.sanitizeChatMessage(rawMsg);

    let isCommand = false;
    let commandType: "friend" | "creative" | "allow" | undefined;
    let commandArg: string | undefined;

    const friendMatch = cleanMessage.match(/^\/friend\s+(.+)$/i);
    if (friendMatch) {
      isCommand = true;
      commandType = "friend";
      commandArg = friendMatch[1].trim();
    } else {
      const creativeMatch = cleanMessage.match(/^\/creative\s+(.+)$/i);
      if (creativeMatch) {
        isCommand = true;
        commandType = "creative";
        commandArg = creativeMatch[1].trim();
      } else {
        const allowMatch = cleanMessage.match(/^\/allow\s+(.+)$/i);
        if (allowMatch) {
          isCommand = true;
          commandType = "allow";
          commandArg = allowMatch[1].trim();
        }
      }
    }

    return {
      username,
      cleanMessage,
      rawMessage: rawMsg,
      platform,
      isCommand,
      commandType,
      commandArg,
    };
  }
}
