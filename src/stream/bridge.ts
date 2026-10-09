import express, { Request, Response, NextFunction } from "express";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import { ConfigManager } from "../config.ts";
import { Log } from "../logger.ts";
import { FriendInfo, XboxLiveClient } from "./xbox.ts";
import { StreamDiscordIntegrationManager } from "./discord_integration.ts";
import { SocialStreamPayload } from "./types.ts";
import { SocialStreamPayloadParser } from "./payload.ts";
import { t } from "../i18n/index.ts";

export interface WhitelistPlayer {
  originalName: string;
  expiresAt: Date;
  timeoutId: number | ReturnType<typeof setTimeout>;
}

const POLL_LIST_REQUEST_ID = "00000000-0000-0000-0000-000000000001";

export class StreamMinecraftBridge {
  private static TAG = "StreamBridge";
  private static STATE_FILE_PATH = "./mc_stream_state.json";

  private static httpServer: http.Server | null = null;
  private static wss: WebSocketServer | null = null;
  public static isRunning = false;

  public static friendCache: Record<string, FriendInfo> = {};
  public static blacklist: string[] = [];
  public static incomingRequestsCache = new Map<string, string>();
  public static whitelist = new Map<string, WhitelistPlayer>();
  public static pendingCreativeQueue = new Set<string>();
  public static onlinePlayers = new Set<string>();
  public static connectedMcClients = new Set<WebSocket>();
  public static pollTimer: any = null;
  public static playerCasingMap = new Map<string, string>();
  public static xboxClient = new XboxLiveClient();

  static async start() {
    if (this.isRunning) {
      Log.warn(this.TAG, "Stream Chat Minecraft Bridge Engine is already running.");
      return;
    }
    this.isRunning = true;
    Log.info(this.TAG, "Starting Stream Chat Minecraft Bridge Engine...");
    await this.loadStreamState();
    await this.xboxClient.init();

    const app = express();
    app.use(express.json());
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") {
        return res.sendStatus(200);
      }
      next();
    });

    app.post("/webhook", (req: Request, res: Response) => {
      try {
        const payload = req.body as SocialStreamPayload;
        Log.debug(this.TAG, "Received Social Stream webhook payload:", payload);
        const parsed = SocialStreamPayloadParser.parse(payload);
        if (parsed) {
          const { platform, username, cleanMessage, isCommand, commandType, commandArg } = parsed;
          if (isCommand && commandType && commandArg) {
            switch (commandType) {
              case "friend":
                this.handleFriendRequest(platform, username, commandArg);
                break;
              case "creative":
                this.handleCreativeRequest(platform, username, commandArg);
                break;
              case "allow":
                this.handleAllowRequest(platform, username, commandArg);
                break;
            }
          }
          StreamDiscordIntegrationManager.relayPlatformChat(platform, username, cleanMessage);
        }
      } catch (err) {
        Log.error(this.TAG, "Error handling webhook payload:", err);
      }
      res.status(200).json({ status: "ok" });
    });

    const server = http.createServer(app);
    this.httpServer = server;
    const wss = new WebSocketServer({ server });
    this.wss = wss;

    wss.on("connection", (ws: WebSocket) => {
      Log.success(this.TAG, "Minecraft Client connected.");
      this.connectedMcClients.add(ws);

      const subscribePacket = {
        header: {
          version: 1,
          requestId: uuidv4(),
          messagePurpose: "subscribe",
          messageType: "commandRequest",
        },
        body: {
          eventName: "PlayerMessage",
        },
      };
      ws.send(JSON.stringify(subscribePacket));

      if (this.connectedMcClients.size === 1) {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.broadcastMcCommand("list", POLL_LIST_REQUEST_ID);
        this.pollTimer = setInterval(() => {
          if (this.connectedMcClients.size === 0) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            return;
          }
          this.broadcastMcCommand("list", POLL_LIST_REQUEST_ID);
        }, 5000);
      }

      ws.on("message", (message: string) => {
        try {
          const response = JSON.parse(message);
          Log.debug(this.TAG, "Received Minecraft Client message:", response);

          const purpose = response.header?.messagePurpose;
          const requestId = response.header?.requestId;
          const eventName = response.header?.eventName || response.body?.eventName;
          const isAddonResponse = response.body?.source === "websocket-addon";

          if (purpose === "commandResponse" && requestId === POLL_LIST_REQUEST_ID) {
            const playersStr = response.body?.players || "";
            const currentActivePlayers = playersStr.split(",").map((p: string) => p.trim()).filter(Boolean);
            const currentActiveSet = new Set(currentActivePlayers.map((p: string) => p.toLowerCase()));

            for (const player of currentActivePlayers) {
              const normalized = player.toLowerCase();
              if (!this.onlinePlayers.has(normalized)) {
                this.playerCasingMap.set(normalized, player);
                this.handleGameJoin(player);
              }
            }

            for (const normalized of Array.from(this.onlinePlayers)) {
              if (!currentActiveSet.has(normalized)) {
                const originalName = this.playerCasingMap.get(normalized) || normalized;
                this.playerCasingMap.delete(normalized);
                this.handleGameLeave(originalName);
              }
            }
          }

          if (purpose === "event" && eventName === "PlayerJoin") {
            const playerJoined = response.body?.player;
            if (playerJoined) {
              const normalized = playerJoined.toLowerCase();
              if (!this.onlinePlayers.has(normalized)) {
                this.playerCasingMap.set(normalized, playerJoined);
                this.handleGameJoin(playerJoined);
              }
            }
          }

          if (purpose === "event" && eventName === "PlayerLeave") {
            const playerLeft = response.body?.playerName;
            if (playerLeft) {
              const normalized = playerLeft.toLowerCase();
              if (this.onlinePlayers.has(normalized)) {
                const originalName = this.playerCasingMap.get(normalized) || playerLeft;
                this.playerCasingMap.delete(normalized);
                this.handleGameLeave(originalName);
              }
            }
          }

          if ((purpose === "event" || eventName === "PlayerMessage") && (eventName === "PlayerMessage" || response.body?.type === "chat")) {
            const sender = response.body?.sender || response.body?.properties?.Sender || "";
            const chatMsg = response.body?.message || response.body?.properties?.Message || "";

            if (sender && chatMsg) {
              const isHost = sender.toLowerCase() === ConfigManager.STREAM_CONFIG.streamer.xboxGamertag.toLowerCase();
              const isExternal = sender.toLowerCase() === "external";

              if (!isHost && !isExternal) {
                StreamDiscordIntegrationManager.relayMinecraftChat(sender, chatMsg);
              }
            }
          }
        } catch { /* Suppress parsing errors */ }
      });

      ws.on("close", () => {
        Log.warn(this.TAG, "Minecraft Client disconnected.");
        this.connectedMcClients.delete(ws);
        this.onlinePlayers.clear();
        this.playerCasingMap.clear();

        if (this.connectedMcClients.size === 0 && this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
      });
    });

    server.listen(ConfigManager.STREAM_CONFIG.port, "0.0.0.0", () => {
      Log.success(this.TAG, `Stream Bridge Webhook listening at http://0.0.0.0:${ConfigManager.STREAM_CONFIG.port}/webhook`);
    });
  }

  static async loadStreamState() {
    try {
      Log.debug(this.TAG, `[LOCAL LOAD] Reading local stream state from "${this.STATE_FILE_PATH}"`);
      const data = await Deno.readTextFile(this.STATE_FILE_PATH);
      const val = JSON.parse(data) || {};
      this.friendCache = val.friends || {};
      this.blacklist = val.blacklist || [];
      Log.info(this.TAG, `Local stream state loaded (${Object.keys(this.friendCache).length} friends, ${this.blacklist.length} blacklisted).`);
    } catch {
      Log.info(this.TAG, "No existing local stream state file found. Initializing empty state store.");
      this.friendCache = {};
      this.blacklist = [];
    }
  }

  static async saveStreamState() {
    try {
      const payload = {
        friends: this.friendCache,
        blacklist: this.blacklist,
      };
      Log.debug(this.TAG, `[LOCAL SAVE] Writing stream state to local file "${this.STATE_FILE_PATH}"`);
      await Deno.writeTextFile(this.STATE_FILE_PATH, JSON.stringify(payload, null, 2));
    } catch (e) {
      Log.error(this.TAG, "Error saving local stream state file:", e);
    }
  }

  static isGamertagValid(gamertag: string): boolean {
    return /^[a-zA-Z0-9]([a-zA-Z0-9 ]{0,13}[a-zA-Z0-9])?$/.test(gamertag);
  }

  static async sendFeedback(message: string) {
    Log.info(this.TAG, `[Feedback] ${message}`);
    this.broadcastMcCommand(`say \u00a7b${ConfigManager.STREAM_CONFIG.botPrefix}\u00a7f ${message}`);
    if (ConfigManager.STREAM_CONFIG.feedback.enableDiscordWebhook && ConfigManager.STREAM_CONFIG.feedback.discordWebhookUrl) {
      try {
        await fetch(ConfigManager.STREAM_CONFIG.feedback.discordWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `**${ConfigManager.STREAM_CONFIG.botPrefix}**: ${message}` }),
        });
      } catch { /* Suppress */ }
    }
  }

  static async handleFriendRequest(senderPlatform: string, senderUser: string, gamertag: string) {
    gamertag = gamertag.trim();
    if (!this.isGamertagValid(gamertag)) {
      await this.sendFeedback(t("stream.invalid_gamertag", { user: senderUser, gamertag }));
      return;
    }
    if (this.blacklist.includes(gamertag.toLowerCase())) {
      await this.sendFeedback(t("stream.blacklisted_gamertag", { user: senderUser, gamertag }));
      return;
    }
    const alreadyFriends = Object.values(this.friendCache).some(
      (f) => f.gamertag.toLowerCase() === gamertag.toLowerCase()
    );
    if (alreadyFriends) {
      await this.sendFeedback(t("stream.already_friends", { user: senderUser, gamertag }));
      return;
    }
    let targetXuid: string | null = null;
    for (const [xuid, gt] of this.incomingRequestsCache.entries()) {
      if (gt.toLowerCase() === gamertag.toLowerCase()) {
        targetXuid = xuid;
        break;
      }
    }
    if (!targetXuid) {
      await this.sendFeedback(
        t("stream.add_friend_first", { user: senderUser, host: ConfigManager.STREAM_CONFIG.streamer.xboxGamertag })
      );
      return;
    }
    if (Object.keys(this.friendCache).length >= ConfigManager.STREAM_CONFIG.friendLimitThreshold) {
      await this.performAutoCleanup();
    }
    const success = await this.xboxClient.acceptFriendRequest(targetXuid, gamertag);
    if (success) {
      this.friendCache[targetXuid] = {
        gamertag: gamertag,
        addedAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        lastPlayedWithMe: "",
      };
      await this.saveStreamState();
      this.incomingRequestsCache.delete(targetXuid);
      await this.sendFeedback(t("stream.friend_success", { user: senderUser, gamertag }));
    } else {
      await this.sendFeedback(t("stream.friend_failed", { gamertag }));
    }
  }

  static async handleCreativeRequest(senderPlatform: string, senderUser: string, gamertag: string) {
    gamertag = gamertag.trim();
    const normalizedGT = gamertag.toLowerCase();
    if (!this.isGamertagValid(gamertag)) {
      await this.sendFeedback(t("stream.invalid_gamertag", { user: senderUser, gamertag }));
      return;
    }
    if (this.blacklist.includes(normalizedGT)) {
      await this.sendFeedback(t("stream.blacklisted_gamertag", { user: senderUser, gamertag }));
      return;
    }
    if (!ConfigManager.STREAM_CONFIG.isCreativeWorld) {
      await this.sendFeedback(t("stream.not_creative_world", { user: senderUser }));
      return;
    }
    const isFriend = Object.values(this.friendCache).some(
      (f) => f.gamertag.toLowerCase() === normalizedGT
    );
    const isAdmin = ConfigManager.STREAM_CONFIG.streamer.adminUsernames.some(
      (adm) => adm.toLowerCase() === senderUser.toLowerCase()
    ) || senderUser.toLowerCase() === ConfigManager.STREAM_CONFIG.streamer.youtubeUsername.toLowerCase();

    if (!isFriend && !isAdmin) {
      await this.sendFeedback(t("stream.must_be_friend_first", { user: senderUser, gamertag }));
      return;
    }
    if (isFriend) {
      const foundEntry = Object.entries(this.friendCache).find(
        ([_, info]) => info.gamertag.toLowerCase() === normalizedGT
      );
      if (foundEntry) {
        this.friendCache[foundEntry[0]].lastActive = new Date().toISOString();
        await this.saveStreamState();
      }
    }
    const durationMs = ConfigManager.STREAM_CONFIG.whitelistDurationMinutes * 60 * 1000;
    const expiresAt = new Date(Date.now() + durationMs);

    if (this.whitelist.has(normalizedGT)) {
      clearTimeout(this.whitelist.get(normalizedGT)!.timeoutId);
    }

    const timeoutId = setTimeout(() => {
      this.whitelist.delete(normalizedGT);
      this.broadcastMcCommand(`gamemode adventure "${gamertag}"`);
      this.sendFeedback(t("stream.creative_expired", { gamertag }));
    }, durationMs);

    this.whitelist.set(normalizedGT, { originalName: gamertag, expiresAt, timeoutId });

    if (this.onlinePlayers.has(normalizedGT)) {
      this.broadcastMcCommand(`gamemode creative "${gamertag}"`);
      await this.sendFeedback(
        t("stream.creative_success", {
          user: senderUser,
          gamertag,
          duration: ConfigManager.STREAM_CONFIG.whitelistDurationMinutes,
        })
      );
    } else {
      this.pendingCreativeQueue.add(normalizedGT);
      await this.sendFeedback(t("stream.creative_queued", { user: senderUser, gamertag }));
    }
  }

  static async handleAllowRequest(senderPlatform: string, senderUser: string, gamertag: string) {
    gamertag = gamertag.trim();
    if (!this.isGamertagValid(gamertag)) {
      await this.sendFeedback(`@${senderUser}, gamertag "${gamertag}" tidak valid.`);
      return;
    }
    const isFriend = Object.values(this.friendCache).some(
      (f) => f.gamertag.toLowerCase() === gamertag.toLowerCase()
    );
    if (!isFriend) {
      await this.sendFeedback(`@${senderUser}, Anda belum berteman dengan Host! Silakan kirim Friend Request terlebih dahulu dan gunakan \`/friend ${gamertag}\`.`);
      return;
    }
    this.broadcastMcCommand(`allowlist add "${gamertag}"`);
    await this.sendFeedback(`Sukses! Gamertag "${gamertag}" telah ditambahkan ke allowlist server BDS.`);
  }

  static async performAutoCleanup() {
    Log.info(this.TAG, "Performing automatic friend list cleanup...");
    const entries = Object.entries(this.friendCache);
    entries.sort((a, b) => {
      const activeA = new Date(a[1].lastActive).getTime();
      const activeB = new Date(b[1].lastActive).getTime();
      if (activeA !== activeB) return activeA - activeB;
      const addedA = new Date(a[1].addedAt).getTime();
      const addedB = new Date(b[1].addedAt).getTime();
      return addedA - addedB;
    });

    const targetToRemoves = entries.slice(0, 15);
    for (const [xuid] of targetToRemoves) {
      const success = await this.xboxClient.removeFriend(xuid);
      if (success) delete this.friendCache[xuid];
    }
    await this.saveStreamState();
  }

  static handleGameJoin(playerName: string) {
    const normalized = playerName.trim().toLowerCase();
    this.onlinePlayers.add(normalized);
    Log.info(this.TAG, `Player joined game: ${playerName}`);

    const foundEntry = Object.entries(this.friendCache).find(
      ([_, info]) => info.gamertag.toLowerCase() === normalized
    );
    if (foundEntry) {
      const xuid = foundEntry[0];
      this.friendCache[xuid].lastPlayedWithMe = new Date().toISOString();
      this.friendCache[xuid].lastActive = new Date().toISOString();
      this.saveStreamState();
    }

    const isStreamerOrAdmin = normalized === ConfigManager.STREAM_CONFIG.streamer.xboxGamertag.toLowerCase() ||
      ConfigManager.STREAM_CONFIG.streamer.adminUsernames.some((admin) => admin.toLowerCase() === normalized);

    if (isStreamerOrAdmin || !ConfigManager.STREAM_CONFIG.isCreativeWorld) return;

    if (this.pendingCreativeQueue.has(normalized) || this.whitelist.has(normalized)) {
      this.pendingCreativeQueue.delete(normalized);
      this.broadcastMcCommand(`gamemode creative "${playerName}"`);
      this.sendFeedback(`Mengubah gamemode "${playerName}" ke Creative karena status whitelist aktif.`);
    } else {
      this.broadcastMcCommand(`gamemode adventure "${playerName}"`);
      Log.info(this.TAG, `Secured world: set ${playerName} to Adventure.`);
    }
  }

  static handleGameLeave(playerName: string) {
    const normalized = playerName.trim().toLowerCase();
    this.onlinePlayers.delete(normalized);
    Log.info(this.TAG, `Player left game: ${playerName}`);

    const foundEntry = Object.entries(this.friendCache).find(
      ([_, info]) => info.gamertag.toLowerCase() === normalized
    );
    if (foundEntry) {
      const xuid = foundEntry[0];
      this.friendCache[xuid].lastPlayedWithMe = new Date().toISOString();
      this.friendCache[xuid].lastActive = new Date().toISOString();
      this.saveStreamState();
    }
  }

  static broadcastMcCommand(commandLine: string, requestId: string = uuidv4()) {
    const payload = {
      header: { version: 1, requestId, messagePurpose: "commandRequest", messageType: "commandRequest" },
      body: { commandLine, version: 1 },
    };
    const stringified = JSON.stringify(payload);
    this.connectedMcClients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(stringified);
    });
  }

  static async stop(): Promise<void> {
    if (!this.isRunning) return;
    Log.warn(this.TAG, "Stopping Stream Chat Minecraft Bridge Engine...");
    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const [_, player] of this.whitelist) {
      if (player.timeoutId) {
        clearTimeout(player.timeoutId as any);
      }
    }
    this.whitelist.clear();
    this.pendingCreativeQueue.clear();
    this.onlinePlayers.clear();
    this.playerCasingMap.clear();

    for (const ws of this.connectedMcClients) {
      try {
        ws.terminate();
      } catch (_) {
        // Ignore
      }
    }
    this.connectedMcClients.clear();

    if (this.wss) {
      try {
        this.wss.close();
      } catch (_) {
        // Ignore
      }
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
        setTimeout(resolve, 1000);
      });
      this.httpServer = null;
    }

    await StreamDiscordIntegrationManager.stopIntegration();

    Log.success(this.TAG, "Stream Chat Minecraft Bridge Engine stopped successfully.");
  }
}

