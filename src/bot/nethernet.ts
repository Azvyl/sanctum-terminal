import { EmbedBuilder } from "discord.js";
import { Log } from "../logger.ts";
import { t } from "../i18n/index.ts";
import { cleanMinecraftFormatting } from "./raknet.ts";
import { validateTargetHost } from "./ssrf.ts";

const TAG = "NetherNet";

export interface NetherNetServerMetrics {
  name: string;
  protocol: number;
  version: string;
  level: string;
  players: number;
  maxPlayers: number;
  gameType: number;
  latencyMs: number;
  endpoint: string;
  isHttps: boolean;
}

export function formatNetherNetGameType(gameType: number): string {
  switch (gameType) {
    case 0:
      return "Survival";
    case 1:
      return "Creative";
    case 2:
      return "Adventure";
    case 3:
      return "Spectator";
    default:
      return `Unknown (${gameType})`;
  }
}

async function requestJoinEndpoint(
  protocol: "http" | "https",
  urlHost: string,
  port: number,
  timeoutMs: number,
): Promise<{ response: Response; latencyMs: number }> {
  const url = `${protocol}://${urlHost}:${port}/v1/join`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startTime = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    return { response, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

export async function pingNetherNet(
  host: string,
  port = 19132,
  timeoutMs = 5000,
): Promise<NetherNetServerMetrics> {
  await validateTargetHost(host);
  const cleanHost = host.trim();
  const isIpv6 = cleanHost.includes(":") && !cleanHost.startsWith("[");
  const urlHost = isIpv6 ? `[${cleanHost}]` : cleanHost;

  const totalStartTime = performance.now();
  const httpTimeout = Math.max(1500, Math.floor(timeoutMs / 2));
  let activeResponse: Response | null = null;
  let isHttps = false;
  let latencyMs = 0;
  let httpError: unknown = null;

  try {
    const httpResult = await requestJoinEndpoint("http", urlHost, port, httpTimeout);
    if (httpResult.response.ok) {
      activeResponse = httpResult.response;
      latencyMs = httpResult.latencyMs;
      isHttps = false;
    } else {
      httpError = new Error(`HTTP ${httpResult.response.status} ${httpResult.response.statusText}`);
    }
  } catch (err) {
    httpError = err;
  }

  if (!activeResponse) {
    const elapsed = performance.now() - totalStartTime;
    const remainingTimeout = Math.max(1500, timeoutMs - elapsed);
    try {
      const httpsResult = await requestJoinEndpoint("https", urlHost, port, remainingTimeout);
      if (httpsResult.response.ok) {
        activeResponse = httpsResult.response;
        latencyMs = httpsResult.latencyMs;
        isHttps = true;
      } else {
        throw new Error(`HTTP ${httpsResult.response.status} ${httpsResult.response.statusText}`);
      }
    } catch (httpsError) {
      Log.debug(TAG, `NetherNet probe failed for ${cleanHost}:${port}`, {
        httpError,
        httpsError,
      });
      throw new Error(
        `NetherNet endpoint unreachable or returned non-2xx status (HTTP: ${httpError instanceof Error ? httpError.message : String(httpError)
        }, HTTPS: ${httpsError instanceof Error ? httpsError.message : String(httpsError)
        })`,
      );
    }
  }

  let data: unknown;
  try {
    data = await activeResponse.json();
  } catch (err) {
    throw new Error(
      `Invalid JSON received from NetherNet endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!data || typeof data !== "object") {
    throw new Error("Invalid NetherNet response: Expected JSON object payload");
  }

  const payload = data as Record<string, unknown>;

  let gameTypeNum = 0;
  if (typeof payload.gameType === "number") {
    gameTypeNum = payload.gameType;
  } else if (typeof payload.gameType === "string") {
    const parsed = parseInt(payload.gameType, 10);
    if (!isNaN(parsed)) {
      gameTypeNum = parsed;
    } else {
      const lower = payload.gameType.toLowerCase();
      if (lower.includes("creative")) gameTypeNum = 1;
      else if (lower.includes("adventure")) gameTypeNum = 2;
      else if (lower.includes("spectator")) gameTypeNum = 3;
      else gameTypeNum = 0;
    }
  }

  const name = typeof payload.name === "string" ? cleanMinecraftFormatting(payload.name) : "Minecraft Server";
  const protocol = typeof payload.protocol === "number" ? payload.protocol : (parseInt(String(payload.protocol), 10) || 0);
  const version = typeof payload.version === "string" ? payload.version : String(payload.version || "Unknown");
  const level = typeof payload.level === "string" ? cleanMinecraftFormatting(payload.level) : "-";
  const players = typeof payload.players === "number" ? payload.players : (parseInt(String(payload.players), 10) || 0);
  const maxPlayers = typeof payload.maxPlayers === "number" ? payload.maxPlayers : (parseInt(String(payload.maxPlayers), 10) || 0);

  return {
    name,
    protocol,
    version,
    level,
    players,
    maxPlayers,
    gameType: gameTypeNum,
    latencyMs,
    endpoint: `${cleanHost}:${port}`,
    isHttps,
  };
}

export function buildNetherNetEmbed(metrics: NetherNetServerMetrics): EmbedBuilder {
  const endpointUrl = `${metrics.isHttps ? "https" : "http"}://${metrics.endpoint}`;

  const embed = new EmbedBuilder()
    .setTitle(t("mcping.nethernet_title"))
    .setColor(0x46FF27)
    .addFields(
      {
        name: t("mcping.field_endpoint"),
        value: `\`${endpointUrl}\``,
        inline: true,
      },
      {
        name: t("mcping.field_version"),
        value: `\`${metrics.version}\` (Proto: \`${metrics.protocol}\`)`,
        inline: true,
      },
      {
        name: t("mcping.field_players"),
        value: `\`${metrics.players} / ${metrics.maxPlayers}\``,
        inline: true,
      },
      {
        name: t("mcping.field_server_name"),
        value: `\`\`\`\n${metrics.name}\n\`\`\``,
        inline: false,
      },
      {
        name: t("mcping.field_level"),
        value: `\`${metrics.level || "-"}\``,
        inline: true,
      },
      {
        name: t("mcping.field_gamemode"),
        value: `\`${formatNetherNetGameType(metrics.gameType)}\``,
        inline: true,
      },
      {
        name: t("mcping.field_latency"),
        value: `\`${metrics.latencyMs} ms\``,
        inline: true,
      },
    )
    .setFooter({
      text: `${t("mcping.footer_bedrock_nethernet")}`,
    })
    .setTimestamp();

  return embed;
}
