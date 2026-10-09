import readline from "node:readline";
import { ConfigManager } from "./config.ts";
import { Log } from "./logger.ts";
import { StreamMinecraftBridge } from "./stream/bridge.ts";
import { StreamDiscordIntegrationManager } from "./stream/discord_integration.ts";
import { ServiceElectionCoordinator } from "./watchdog.ts";

export class TerminalCli {
  private static TAG = "TerminalCLI";

  static start() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(false);
    }
    process.stdin.resume();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl.on("line", async (line) => {
      const input = line.trim();
      if (!input) return;

      const parts = input.split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      switch (command) {
        case "help":
          Log.cli("\n--- SANCTUM TERMINAL GLOBAL CLI ---");
          Log.cli("  help                            - Display global system CLI help");
          Log.cli("  status                          - Display general node and application status");
          Log.cli("  exit / quit                     - Gracefully exit the entire application");
          Log.cli("\n--- SUBSYSTEM COMMANDS ---");
          Log.cli("  stream <subcommand>             - Access Minecraft Stream Bridge & Discord Integration commands");
          Log.cli("                                    (e.g., 'stream help', 'stream status', 'stream online')\n");
          break;
        case "status": {
          const activeServices = ServiceElectionCoordinator.getActiveServices();
          Log.cli("\n--- SCHALE CENTRAL SYSTEM STATUS ---");
          Log.cli(`  Node ID             : ${ConfigManager.NODE_ID}`);
          Log.cli(`  Node Name           : ${ConfigManager.NODE_NAME}`);
          Log.cli(`  Operating System    : ${Deno.build.os}`);
          Log.cli(`  Enabled Services    : ${ConfigManager.ENABLED_SERVICES.join(", ") || "None (Telemetry Only)"}`);
          Log.cli(`  Active Services     : ${activeServices.join(", ") || "None (Standby)"}`);
          Log.cli(`  Debug Log Status    : ${ConfigManager.IS_DEBUG}`);
          Log.cli(`  Active Stream Post  : ${StreamDiscordIntegrationManager.activePostId || "None"}\n`);
          break;
        }
        case "exit":
        case "quit":
          Log.warn(this.TAG, "Exit signal received via Terminal CLI. Triggering graceful shutdown...");
          try {
            process.kill(process.pid, "SIGINT");
          } catch (_) {
            Deno.kill(Deno.pid, "SIGINT");
          }
          break;
        case "stream":
          await this.handleStreamCommand(args);
          break;
        default:
          Log.cli(`Unknown CLI command: "${input}". Type "help" or "stream help" for available commands.`);
          break;
      }
    });
  }

  private static async handleStreamCommand(args: string[]) {
    const sub = args[0]?.toLowerCase() || "help";
    const subArgs = args.slice(1);

    switch (sub) {
      case "help":
        Log.cli("\n--- STREAM BRIDGE & DISCORD INTEGRATION CLI COMMANDS ---");
        Log.cli("  stream status                   - Display stream bridge connection status");
        Log.cli("  stream discord-integration start <title> <msg> - Open new post in #chat-integration & relay stream chat");
        Log.cli("  stream discord-integration resume <post_id>   - Resume relaying stream chat to existing post");
        Log.cli("  stream discord-integration stop               - Stop relaying stream chat");
        Log.cli("  stream blacklist list           - Display blacklisted gamertags");
        Log.cli("  stream blacklist add <gt>       - Add gamertag to blacklist");
        Log.cli("  stream blacklist remove <gt>    - Remove gamertag from blacklist");
        Log.cli("  stream whitelist                - Display active creative whitelist entries");
        Log.cli("  stream online                   - Display current online Minecraft players");
        Log.cli("  stream friends                  - Display cached Xbox friends");
        Log.cli("  stream requests                 - Display pending Xbox friend requests");
        Log.cli("  stream mock <platform> <usr> <msg> - Simulate stream chat message");
        Log.cli("  stream cmd <mc_command>         - Dispatch command to Minecraft server\n");
        break;

      case "discord-integration": {
        const action = subArgs[0]?.toLowerCase();
        if (action === "start") {
          const restArgs = subArgs.slice(1).join(" ");
          let title = "";
          let message = "";

          if (restArgs.startsWith('"')) {
            const closingQuote = restArgs.indexOf('"', 1);
            if (closingQuote > -1) {
              title = restArgs.slice(1, closingQuote).trim();
              message = restArgs.slice(closingQuote + 1).trim();
            }
          }

          if (!title) {
            const parts = subArgs.slice(1);
            title = parts[0] || "";
            message = parts.slice(1).join(" ");
          }

          message = message.replaceAll("\\n", "\n");

          if (!title || !message) {
            Log.cli("Usage: stream discord-integration start <post title> <post message>");
            break;
          }

          const ok = await StreamDiscordIntegrationManager.startIntegration(title, message);
          if (ok) {
            Log.cli(`[Discord Integration] Started new post: "${title}" (ID: ${StreamDiscordIntegrationManager.activePostId})`);
          } else {
            Log.cli("[Discord Integration] Failed to start stream integration post.");
          }
        } else if (action === "resume") {
          const targetPostId = subArgs[1]?.trim();
          if (!targetPostId) {
            Log.cli("Usage: stream discord-integration resume <post id>");
            break;
          }

          const ok = await StreamDiscordIntegrationManager.resumeIntegration(targetPostId);
          if (ok) {
            Log.cli(`[Discord Integration] Resumed stream chat on post ID: ${targetPostId}`);
          } else {
            Log.cli(`[Discord Integration] Failed to resume on post ID: ${targetPostId}`);
          }
        } else if (action === "stop") {
          await StreamDiscordIntegrationManager.stopIntegration();
          Log.cli("[Discord Integration] Stopped stream chat integration.");
        } else {
          Log.cli("Usage: stream discord-integration <start|resume|stop>");
        }
        break;
      }

      case "status":
        Log.cli("\n--- STREAM BRIDGE STATUS ---");
        Log.cli(`  MC Connected Clients: ${StreamMinecraftBridge.connectedMcClients.size}`);
        Log.cli(`  Online Players      : ${StreamMinecraftBridge.onlinePlayers.size}`);
        Log.cli(`  Creative World      : ${ConfigManager.STREAM_CONFIG.isCreativeWorld}`);
        Log.cli(`  Active Discord Post : ${StreamDiscordIntegrationManager.activePostId || "None"}`);
        Log.cli(`  Cached Friends      : ${Object.keys(StreamMinecraftBridge.friendCache).length} / ${ConfigManager.STREAM_CONFIG.friendLimitThreshold}`);
        Log.cli(`  Pending Requests    : ${StreamMinecraftBridge.incomingRequestsCache.size}`);
        Log.cli(`  Streamer Gamertag   : ${ConfigManager.STREAM_CONFIG.streamer.xboxGamertag}\n`);
        break;

      case "blacklist": {
        const action = subArgs[0]?.toLowerCase();
        const target = subArgs.slice(1).join(" ").trim().toLowerCase();
        if (action === "list") {
          Log.cli(`\n--- BLACKLIST (${StreamMinecraftBridge.blacklist.length}) ---`);
          StreamMinecraftBridge.blacklist.forEach((gt) => Log.cli(`  - ${gt}`));
          Log.cli();
        } else if (action === "add" && target) {
          if (!StreamMinecraftBridge.blacklist.includes(target)) {
            StreamMinecraftBridge.blacklist.push(target);
            await StreamMinecraftBridge.saveStreamState();
            Log.cli(`[Blacklist] Added "${target}".`);
          }
        } else if (action === "remove" && target) {
          const idx = StreamMinecraftBridge.blacklist.indexOf(target);
          if (idx > -1) {
            StreamMinecraftBridge.blacklist.splice(idx, 1);
            await StreamMinecraftBridge.saveStreamState();
            Log.cli(`[Blacklist] Removed "${target}".`);
          }
        } else {
          Log.cli("Usage: stream blacklist <list|add|remove> [gamertag]");
        }
        break;
      }

      case "whitelist":
        Log.cli(`\n--- ACTIVE CREATIVE WHITELIST (${StreamMinecraftBridge.whitelist.size}) ---`);
        StreamMinecraftBridge.whitelist.forEach((val) => {
          const minsLeft = Math.max(0, Math.round((val.expiresAt.getTime() - Date.now()) / 60000));
          Log.cli(`  - ${val.originalName} (~${minsLeft} mins left)`);
        });
        Log.cli();
        break;

      case "online":
        Log.cli(`\n--- ONLINE PLAYERS (${StreamMinecraftBridge.onlinePlayers.size}) ---`);
        StreamMinecraftBridge.onlinePlayers.forEach((p) => Log.cli(`  - ${p}`));
        Log.cli();
        break;

      case "friends":
        Log.cli(`\n--- CACHED FRIENDS (${Object.keys(StreamMinecraftBridge.friendCache).length}) ---`);
        Object.entries(StreamMinecraftBridge.friendCache).forEach(([xuid, info]) => {
          Log.cli(`  - ${info.gamertag} (XUID: ${xuid}, Added: ${info.addedAt})`);
        });
        Log.cli();
        break;

      case "requests":
        Log.cli(`\n--- PENDING REQUESTS (${StreamMinecraftBridge.incomingRequestsCache.size}) ---`);
        StreamMinecraftBridge.incomingRequestsCache.forEach((gt, xuid) => {
          Log.cli(`  - ${gt} (XUID: ${xuid})`);
        });
        Log.cli();
        break;

      case "mock": {
        const platform = subArgs[0];
        const mockUser = subArgs[1];
        const mockMsg = subArgs.slice(2).join(" ");
        if (platform && mockUser && mockMsg) {
          const fMatch = mockMsg.match(/^\/friend\s+(.+)$/i);
          if (fMatch) StreamMinecraftBridge.handleFriendRequest(platform, mockUser, fMatch[1]);

          const cMatch = mockMsg.match(/^\/creative\s+(.+)$/i);
          if (cMatch) StreamMinecraftBridge.handleCreativeRequest(platform, mockUser, cMatch[1]);

          await StreamDiscordIntegrationManager.relayPlatformChat(platform, mockUser, mockMsg);
        } else {
          Log.cli("Usage: stream mock <platform> <username> <message>");
        }
        break;
      }

      case "cmd": {
        const mcCmd = subArgs.join(" ");
        if (mcCmd) {
          Log.cli(`[Minecraft CLI] Executing: /${mcCmd}`);
          StreamMinecraftBridge.broadcastMcCommand(mcCmd);
        } else {
          Log.cli("Usage: stream cmd <minecraft_command>");
        }
        break;
      }

      default:
        Log.cli(`Unknown stream subcommand: "${sub}". Type "stream help" for available commands.`);
        break;
    }
  }
}
