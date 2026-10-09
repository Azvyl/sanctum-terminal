import { ActivityType, Client, GatewayIntentBits } from "discord.js";
import { ConfigManager } from "../config.ts";
import { Log } from "../logger.ts";
import { SystemTelemetry } from "../telemetry.ts";
import { StreamMinecraftBridge } from "../stream/bridge.ts";
import { deployCommands, handleAutocomplete, handleCommand } from "./commands.ts";
import { UpdateTrackers } from "./trackers.ts";
import { WeatherTrackerEngine } from "./weather.ts";

export class DiscordBotService {
  private static TAG = "DiscordBotService";
  public static client: Client | null = null;
  private static isStarting = false;
  private static trackerIntervalId: ReturnType<typeof setInterval> | null = null;
  private static weatherIntervalId: ReturnType<typeof setInterval> | null = null;
  private static weatherTracker: WeatherTrackerEngine | null = null;

  private static currentActivityIndex = 0;
  private static activityTimeoutId: ReturnType<typeof setTimeout> | null = null;

  static async start() {
    if (!ConfigManager.DISCORD_BOT_TOKEN) {
      Log.error(this.TAG, "DISCORD_BOT_TOKEN is empty! Bot cannot start.");
      return;
    }
    if (this.client || this.isStarting) {
      Log.warn(this.TAG, "DiscordBotService is already active or in process of starting.");
      return;
    }
    this.isStarting = true;
    Log.info(this.TAG, "Starting DiscordBotService...");
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.client.once("clientReady", async () => {
      this.isStarting = false;
      Log.success(this.TAG, `Bot Logged in as: ${this.client?.user?.tag}`);

      await this.startActivityRotation();
      await UpdateTrackers.loadStateFromFirebase();
      await deployCommands();
      this.startLoop();
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
      } else if (interaction.isChatInputCommand()) {
        await handleCommand(interaction);
      }
    });

    try {
      await this.client.login(ConfigManager.DISCORD_BOT_TOKEN);
    } catch (err) {
      this.isStarting = false;
      Log.error(this.TAG, "Failed to login DiscordBotService:", err);
      throw err;
    }
  }

  static async stop() {
    this.isStarting = false;
    if (this.activityTimeoutId !== null) {
      clearTimeout(this.activityTimeoutId);
      this.activityTimeoutId = null;
    }
    if (this.trackerIntervalId !== null) {
      clearInterval(this.trackerIntervalId);
      this.trackerIntervalId = null;
    }
    if (this.weatherIntervalId !== null) {
      clearInterval(this.weatherIntervalId);
      this.weatherIntervalId = null;
    }
    if (this.weatherTracker !== null) {
      this.weatherTracker.destroy();
      this.weatherTracker = null;
    }
    if (this.client) {
      Log.warn(this.TAG, "Stopping local DiscordBotService client instance...");
      try {
        await this.client.destroy();
      } catch (err) {
        Log.error(this.TAG, "Error destroying Discord client instance:", err);
      }
      this.client = null;
      Log.success(this.TAG, "DiscordBotService stopped and client destroyed successfully.");
    }
  }

  private static mapActivityType(typeStr?: string): ActivityType {
    switch (typeStr?.toLowerCase()) {
      case "watching":
        return ActivityType.Watching;
      case "listening":
        return ActivityType.Listening;
      case "custom":
        return ActivityType.Custom;
      case "competing":
        return ActivityType.Competing;
      case "streaming":
        return ActivityType.Streaming;
      case "playing":
      default:
        return ActivityType.Playing;
    }
  }

  private static async formatActivityText(text: string): Promise<string> {
    if (!text.includes("{")) return text;
    let cpu = "-";
    let cpuSpeed = "-";
    let ram = "-";
    let temp = "-";
    try {
      const metrics = await SystemTelemetry.collectMetrics();
      if (metrics.cpu_load >= 0) cpu = `${metrics.cpu_load}%`;
      if (metrics.cpu_speed_ghz > 0) cpuSpeed = `${metrics.cpu_speed_ghz}GHz`;
      if (metrics.ram_used_gb >= 0) ram = `${metrics.ram_used_gb}GB`;
      if (metrics.temp_c >= 0) temp = `${metrics.temp_c}°C`;
    } catch {
      // System telemetry collection error suppressed
    }

    const streamStatus = StreamMinecraftBridge.isRunning ? "Online" : "Idle";
    const streamPlayers = `${StreamMinecraftBridge.onlinePlayers.size}`;

    return text
      .replace(/\{cpu(?:_load)?\}/gi, cpu)
      .replace(/\{cpu_speed\}/gi, cpuSpeed)
      .replace(/\{ram(?:_used)?\}/gi, ram)
      .replace(/\{temp(?:_c)?\}/gi, temp)
      .replace(/\{stream_status\}/gi, streamStatus)
      .replace(/\{stream_players\}/gi, streamPlayers)
      .replace(/\{node(?:_id)?\}/gi, ConfigManager.NODE_ID)
      .replace(/\{node_name|device(?:_name)?\}/gi, ConfigManager.NODE_NAME);
  }

  private static async startActivityRotation() {
    if (this.activityTimeoutId !== null) {
      clearTimeout(this.activityTimeoutId);
      this.activityTimeoutId = null;
    }
    this.currentActivityIndex = 0;
    await this.rotateActivity();
  }

  private static async rotateActivity() {
    if (!this.client || !this.client.user) return;
    const activities = ConfigManager.DISCORD_BOT_ACTIVITIES;
    if (activities.length === 0) return;

    if (this.currentActivityIndex >= activities.length) {
      this.currentActivityIndex = 0;
    }

    const current = activities[this.currentActivityIndex];
    const type = this.mapActivityType(current.type);
    const formattedName = await this.formatActivityText(current.name);
    const formattedState = current.state ? await this.formatActivityText(current.state) : undefined;

    try {
      if (type === ActivityType.Custom) {
        this.client.user.setPresence({
          activities: [
            {
              name: formattedName,
              type: ActivityType.Custom,
              state: formattedState || formattedName,
            },
          ],
        });
      } else {
        this.client.user.setActivity({
          name: formattedName,
          type,
          state: formattedState,
          url: current.url,
        });
      }
      Log.debug(
        this.TAG,
        `Activity rotated to [${current.type || "Playing"}]: "${formattedName}"${formattedState ? ` (State: "${formattedState}")` : ""
        }`,
      );
    } catch (err) {
      Log.warn(this.TAG, "Failed updating bot presence activity:", err);
    }

    const durationSeconds = current.durationSeconds && current.durationSeconds > 0
      ? current.durationSeconds
      : ConfigManager.DISCORD_BOT_ACTIVITY_INTERVAL_SECONDS;

    this.currentActivityIndex = (this.currentActivityIndex + 1) % activities.length;

    this.activityTimeoutId = setTimeout(() => {
      this.rotateActivity();
    }, durationSeconds * 1000);
  }

  private static startLoop() {
    if (!this.client) return;
    const runAll = async () => {
      if (!this.client) return;
      await UpdateTrackers.trackMinecraftBedrock(this.client);
      await UpdateTrackers.trackMinecraftJava(this.client);
      await UpdateTrackers.trackGempaBMKG(this.client);
    };

    runAll();
    this.trackerIntervalId = setInterval(runAll, 120000);

    this.weatherTracker = new WeatherTrackerEngine(this.client);
    this.weatherTracker.runCheck();
    this.weatherIntervalId = setInterval(() => this.weatherTracker?.runCheck(), 300000);
  }
}
