import { WebSocket } from "ws";
// @ts-ignore
import { Authflow, Titles } from "prismarine-auth";
import { ConfigManager } from "../config.ts";
import { Log } from "../logger.ts";
import { StreamMinecraftBridge } from "./bridge.ts";

export interface FriendInfo {
  gamertag: string;
  addedAt: string;
  lastActive: string;
  lastPlayedWithMe: string;
}

export class XboxLiveClient {
  private TAG = "XboxLive";
  private flow: any;
  private hostXuid = "";
  private rtaWs: WebSocket | null = null;

  async init() {
    Log.info(this.TAG, "Initializing Xbox Live Authflow...");
    try {
      this.flow = new Authflow(ConfigManager.STREAM_CONFIG.authName, ConfigManager.STREAM_CONFIG.xboxLive.cacheDir, {
        flow: "live",
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: "Nintendo",
      });

      const token = await this.flow.getXboxToken("http://xboxlive.com");
      this.hostXuid = token.userXUID;
      Log.success(this.TAG, `Authenticated as Host XUID: ${this.hostXuid}`);

      await this.syncFriends();
      await this.syncIncomingRequests();
      this.connectRta();
    } catch (error: any) {
      Log.error(this.TAG, "Xbox Live initialization error:", error.message);
    }
  }

  getHostXuid(): string {
    return this.hostXuid;
  }

  async getAuthHeaders() {
    const auth = await this.flow.getXboxToken("http://xboxlive.com");
    return {
      "Authorization": `XBL3.0 x=${auth.userHash};${auth.XSTSToken}`,
      "x-xbl-contract-version": "2",
      "Accept": "application/json",
    };
  }

  async getAuthHeadersV7() {
    const auth = await this.flow.getXboxToken("http://xboxlive.com");
    return {
      "Authorization": `XBL3.0 x=${auth.userHash};${auth.XSTSToken}`,
      "x-xbl-contract-version": "7",
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
  }

  async syncFriends() {
    try {
      const headers = await this.getAuthHeadersV7();
      const res = await fetch("https://peoplehub.xboxlive.com/users/me/people/friends", { headers });
      if (!res.ok) return;

      const data: any = await res.json();
      if (data && Array.isArray(data.people)) {
        const tempCache: Record<string, FriendInfo> = {};
        for (const person of data.people) {
          const xuid = person.xuid;
          const gt = person.gamertag || person.displayName;
          const existing = StreamMinecraftBridge.friendCache[xuid];
          tempCache[xuid] = {
            gamertag: gt,
            addedAt: person.friendedDateTimeUtc || (existing ? existing.addedAt : new Date().toISOString()),
            lastActive: person.lastSeenDateTimeUtc || (existing ? existing.lastActive : new Date().toISOString()),
            lastPlayedWithMe: existing ? existing.lastPlayedWithMe : "",
          };
        }
        StreamMinecraftBridge.friendCache = tempCache;
        await StreamMinecraftBridge.saveStreamState();
        Log.info(this.TAG, `Friends synced (${Object.keys(StreamMinecraftBridge.friendCache).length} friends).`);
      }
    } catch (err: any) {
      Log.error(this.TAG, `Failed syncing friends list: ${err.message}`);
    }
  }

  async syncIncomingRequests() {
    try {
      const headers = await this.getAuthHeadersV7();
      const res = await fetch("https://peoplehub.xboxlive.com/users/me/people/friendrequests(received)", { headers });
      if (!res.ok) return;

      const data: any = await res.json();
      StreamMinecraftBridge.incomingRequestsCache.clear();
      if (data && Array.isArray(data.people)) {
        for (const person of data.people) {
          StreamMinecraftBridge.incomingRequestsCache.set(person.xuid, person.gamertag);
        }
        Log.info(this.TAG, `Pending friend requests synced (${StreamMinecraftBridge.incomingRequestsCache.size} requests).`);
      }
    } catch (err: any) {
      Log.error(this.TAG, `Failed syncing incoming friend requests: ${err.message}`);
    }
  }

  async fetchUserProfile(xuid: string): Promise<any> {
    try {
      const headers = await this.getAuthHeadersV7();
      const url = `https://peoplehub.xboxlive.com/users/me/people/xuids(${xuid})/decoration/detail,preferredColor,presenceDetail,multiplayerSummary`;
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const data: any = await res.json();
      if (data && Array.isArray(data.people) && data.people.length > 0) {
        return data.people[0];
      }
    } catch { /* Suppress */ }
    return null;
  }

  async handleSingleUserUpdate(xuid: string) {
    const profile = await this.fetchUserProfile(xuid);
    if (!profile) return;

    const gt = profile.gamertag || profile.displayName;
    if (profile.isFriend === true) {
      const existing = StreamMinecraftBridge.friendCache[xuid];
      StreamMinecraftBridge.friendCache[xuid] = {
        gamertag: gt,
        addedAt: profile.friendedDateTimeUtc || (existing ? existing.addedAt : new Date().toISOString()),
        lastActive: profile.lastSeenDateTimeUtc || (existing ? existing.lastActive : new Date().toISOString()),
        lastPlayedWithMe: existing?.lastPlayedWithMe || "",
      };
      await StreamMinecraftBridge.saveStreamState();
    } else if (StreamMinecraftBridge.friendCache[xuid]) {
      delete StreamMinecraftBridge.friendCache[xuid];
      await StreamMinecraftBridge.saveStreamState();
    }

    if (profile.isFriendRequestReceived === true) {
      StreamMinecraftBridge.incomingRequestsCache.set(xuid, gt);
    } else {
      StreamMinecraftBridge.incomingRequestsCache.delete(xuid);
    }
  }

  async handleSingleUserRemoval(xuid: string) {
    if (StreamMinecraftBridge.friendCache[xuid]) {
      delete StreamMinecraftBridge.friendCache[xuid];
      await StreamMinecraftBridge.saveStreamState();
    }
    StreamMinecraftBridge.incomingRequestsCache.delete(xuid);
  }

  async connectRta() {
    try {
      const auth = await this.flow.getXboxToken("http://xboxlive.com");
      const authHeader = `XBL3.0 x=${auth.userHash};${auth.XSTSToken}`;

      if (this.rtaWs) {
        this.rtaWs.removeAllListeners();
        if (this.rtaWs.readyState === WebSocket.OPEN || this.rtaWs.readyState === WebSocket.CONNECTING) {
          this.rtaWs.close();
        }
        this.rtaWs = null;
      }

      this.rtaWs = new WebSocket("wss://rta.xboxlive.com/connect", "rta.xboxlive.com.V2", {
        headers: { "Authorization": authHeader, "Accept": "application/json", "Cache-Control": "no-cache" },
      });

      this.rtaWs.on("open", () => {
        Log.success(this.TAG, "Connected to Xbox RTA WebSocket.");
        this.rtaWs?.send(JSON.stringify([1, 1, "https://sessiondirectory.xboxlive.com/connections/"]));
      });

      this.rtaWs.on("message", async (data: any) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (!Array.isArray(parsed)) return;

          const type = parsed[0];
          const sequenceId = parsed[1];

          if (type === 1 && sequenceId === 1) {
            this.rtaWs?.send(JSON.stringify([1, 2, `https://social.xboxlive.com/users/xuid(${this.hostXuid})/friends`]));
          } else if (type === 3) {
            const eventData = parsed[2];
            if (eventData) {
              if (eventData.NotificationType === "IncomingFriendRequestCountChanged") {
                await this.syncIncomingRequests();
              } else if (eventData.NotificationType === "Added" || eventData.NotificationType === "Changed") {
                if (Array.isArray(eventData.Xuids)) {
                  for (const xuid of eventData.Xuids) await this.handleSingleUserUpdate(xuid);
                }
              } else if (eventData.NotificationType === "Removed") {
                if (Array.isArray(eventData.Xuids)) {
                  for (const xuid of eventData.Xuids) await this.handleSingleUserRemoval(xuid);
                }
              }
            }
          }
        } catch { /* Ignore */ }
      });

      this.rtaWs.on("close", () => {
        setTimeout(() => this.connectRta(), 10000);
      });
    } catch (err: any) {
      Log.error(this.TAG, "RTA Connection failed:", err.message);
    }
  }

  async acceptFriendRequest(targetXuid: string, targetGamertag = "Unknown"): Promise<boolean> {
    try {
      const headers: Record<string, string> = await this.getAuthHeaders();
      headers["x-xbl-contract-version"] = "3";
      const url = `https://social.xboxlive.com/users/me/people/friends/v2/xuid(${targetXuid})`;
      const res = await fetch(url, { method: "PUT", headers });
      return res.status === 200 || res.status === 201 || res.status === 204;
    } catch { return false; }
  }

  async removeFriend(targetXuid: string): Promise<boolean> {
    try {
      const headers: Record<string, string> = await this.getAuthHeaders();
      headers["x-xbl-contract-version"] = "3";
      const url = `https://social.xboxlive.com/users/me/people/friends/v2/xuid(${targetXuid})?deleteRelationships=friends`;
      const res = await fetch(url, { method: "DELETE", headers });
      return res.status === 200 || res.status === 201 || res.status === 204;
    } catch { return false; }
  }
}
