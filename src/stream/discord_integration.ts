import { ChannelType, ForumChannel, ThreadChannel } from "discord.js";
import { get, ref, serverTimestamp, set } from "firebase/database";
import { DiscordBotService } from "../bot/index.ts";
import { DISCORD_CHANNELS } from "../config.ts";
import { DB_PATHS, FirebaseManager } from "../firebase.ts";
import { Log } from "../logger.ts";

export class StreamDiscordIntegrationManager {
  private static TAG = "DiscordIntegration";
  public static activePostId: string | null = null;
  public static activePostTitle: string | null = null;

  static async initialize() {
    Log.info(this.TAG, "Initializing Stream Discord Integration Manager...");
    try {
      const snap = await get(ref(FirebaseManager.db, DB_PATHS.STATE_STREAM_INTEGRATION));
      const val = snap.val();
      if (val && val.activePostId) {
        this.activePostId = val.activePostId;
        this.activePostTitle = val.activePostTitle || null;
        Log.info(this.TAG, `Loaded active stream post ID from Firebase: ${this.activePostId}`);
      }
    } catch (e) {
      Log.error(this.TAG, "Failed to load stream integration state from Firebase:", e);
    }
  }

  static async saveState() {
    try {
      await set(ref(FirebaseManager.db, DB_PATHS.STATE_STREAM_INTEGRATION), {
        activePostId: this.activePostId,
        activePostTitle: this.activePostTitle,
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      Log.error(this.TAG, "Failed to save stream integration state to Firebase:", e);
    }
  }

  static async startIntegration(title: string, message: string): Promise<boolean> {
    const client = DiscordBotService.client;
    if (!client) {
      Log.error(this.TAG, "Discord Bot client is not active/connected.");
      return false;
    }

    try {
      const channel = await client.channels.fetch(DISCORD_CHANNELS.CHAT_INTEGRATION);
      if (!channel || channel.type !== ChannelType.GuildForum) {
        Log.error(this.TAG, `Target channel ${DISCORD_CHANNELS.CHAT_INTEGRATION} is not a GuildForum channel.`);
        return false;
      }

      const forumChannel = channel as ForumChannel;
      const thread = await forumChannel.threads.create({
        name: title,
        message: {
          content: this.sanitizeMentions(message),
          allowedMentions: { parse: [], users: [], roles: [] },
        },
      });

      this.activePostId = thread.id;
      this.activePostTitle = title;
      await this.saveState();

      Log.success(this.TAG, `Started stream chat integration post: "${title}" (ID: ${thread.id})`);
      return true;
    } catch (err) {
      Log.error(this.TAG, "Failed creating stream chat integration post:", err);
      return false;
    }
  }

  static async resumeIntegration(postId: string): Promise<boolean> {
    const client = DiscordBotService.client;
    if (!client) {
      Log.error(this.TAG, "Discord Bot client is not active/connected.");
      return false;
    }

    try {
      const thread = await client.channels.fetch(postId);
      if (!thread || !thread.isThread()) {
        Log.error(this.TAG, `Post ID "${postId}" is not a valid thread channel.`);
        return false;
      }

      this.activePostId = postId;
      this.activePostTitle = (thread as ThreadChannel).name || "Resumed Thread";
      await this.saveState();

      Log.success(this.TAG, `Resumed stream chat integration on post ID: ${postId}`);
      return true;
    } catch (err) {
      Log.error(this.TAG, `Failed to resume stream chat integration on post ${postId}:`, err);
      return false;
    }
  }

  static async stopIntegration(): Promise<boolean> {
    this.activePostId = null;
    this.activePostTitle = null;
    await this.saveState();
    Log.info(this.TAG, "Stopped stream chat integration.");
    return true;
  }

  static async relayMinecraftChat(gamertag: string, chat: string) {
    if (!this.activePostId) return;
    const formattedMsg = `[Minecraft] ${gamertag}: ${chat}`;
    await this.sendToDiscord(formattedMsg);
  }

  static async relayPlatformChat(platform: string, username: string, chat: string) {
    if (!this.activePostId) return;
    let formattedUser = username.trim();
    const cleanPlatform = platform.trim();
    if (cleanPlatform.toLowerCase() === "youtube" && !formattedUser.startsWith("@")) {
      formattedUser = `@${formattedUser}`;
    }
    const formattedMsg = `[${cleanPlatform}] ${formattedUser}: ${chat}`;
    await this.sendToDiscord(formattedMsg);
  }

  private static sanitizeMentions(text: string): string {
    return text
      .replace(/@everyone/gi, "@\u200beveryone")
      .replace(/@here/gi, "@\u200bhere")
      .replace(/<@/g, "<@\u200b")
      .replace(/<@&/g, "<@\u200b&");
  }

  private static async sendToDiscord(text: string) {
    if (!this.activePostId) return;
    const client = DiscordBotService.client;
    if (!client) return;

    try {
      const thread = await client.channels.fetch(this.activePostId);
      if (thread && thread.isThread()) {
        const sanitized = this.sanitizeMentions(text);
        await thread.send({
          content: sanitized,
          allowedMentions: { parse: [], users: [], roles: [] },
        });
        Log.debug(this.TAG, `Relayed chat to Discord post ${this.activePostId}: "${sanitized}"`);
      } else {
        Log.warn(this.TAG, `Active post ${this.activePostId} is no longer accessible.`);
      }
    } catch (err) {
      Log.error(this.TAG, `Failed sending chat to Discord thread ${this.activePostId}:`, err);
    }
  }
}
