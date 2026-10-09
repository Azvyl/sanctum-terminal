import { EmbedBuilder } from "discord.js";
import { Log } from "../logger.ts";
import { t } from "../i18n/index.ts";
import { validateTargetHost } from "./ssrf.ts";

const TAG = "RakNet";

// Offline Message ID Magic: 00ffff00fefefefefdfdfdfd12345678
const OFFLINE_MESSAGE_DATA_ID = new Uint8Array([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
  0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
]);

export interface BedrockServerMetrics {
  edition: string;
  motd: string;
  protocolVersion: string;
  versionName: string;
  currentPlayers: number;
  maxPlayers: number;
  serverGuid: string | null;
  worldName: string | null;
  gamemode: string | null;
  isJoinableThroughServerScreen: boolean | null;
  ipv4Port: number | null;
  ipv6Port: number | null;
  isEditorWorld: boolean | null;
  xboxReachability: boolean | null;
  isOnlineMode: boolean | null;
  latencyMs: number;
  rawPayload: string;
}

export function cleanMinecraftFormatting(text: string): string {
  if (!text) return "";

  return text
    .replace(/§x(?:§[0-9a-fA-F]){6}/gi, "")
    .replace(/§#[0-9a-fA-F]{3,8}/gi, "")
    .replace(/§[0-9a-zA-Z]/g, "")
    .replace(/§/g, "")
    .replace(/[\uE000-\uF8FF]/gu, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function buildUnconnectedPingPacket(timestamp: bigint, clientGuid: bigint = 2n): Uint8Array {
  const packet = new Uint8Array(33);
  packet[0] = 0x01; // ID_UNCONNECTED_PING
  const view = new DataView(packet.buffer);
  view.setBigInt64(1, timestamp, false);
  packet.set(OFFLINE_MESSAGE_DATA_ID, 9);
  view.setBigInt64(25, clientGuid, false);
  return packet;
}

function getField(parts: string[], index: number): string | null {
  if (index >= parts.length) return null;
  const val = parts[index];
  if (val === undefined || val === null || val === "") return null;
  return val;
}

function parseFlag(val: string | null): boolean | null {
  if (val === null) return null;
  if (val === "1") return true;
  if (val === "0") return false;
  return null;
}

function parseOnlineMode(val: string | null): boolean | null {
  if (val === null) return null;
  if (val === "0") return true;
  if (val === "1") return false;
  return null;
}

function parsePort(val: string | null): number | null {
  if (val === null) return null;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

export function parseBedrockPongPayload(
  payloadStr: string,
  latencyMs: number,
): BedrockServerMetrics {
  const cleanStr = payloadStr.trim();
  if (!cleanStr || !cleanStr.startsWith("MCPE;")) {
    throw new Error("Respons Unconnected Pong tidak valid atau bukan server Bedrock.");
  }

  const parts = cleanStr.split(";");
  const edition = getField(parts, 0) || "MCPE";
  const motd = cleanMinecraftFormatting(getField(parts, 1) || "-");
  const protocolVersion = getField(parts, 2) || "-";
  const versionName = getField(parts, 3) || "-";
  const currentPlayers = parseInt(getField(parts, 4) || "0", 10) || 0;
  const maxPlayers = parseInt(getField(parts, 5) || "0", 10) || 0;
  const serverGuid = getField(parts, 6);
  const rawWorld = getField(parts, 7);
  const worldName = rawWorld !== null ? cleanMinecraftFormatting(rawWorld) : null;
  const gamemode = getField(parts, 8);
  const isJoinableThroughServerScreen = parseFlag(getField(parts, 9));
  const ipv4Port = parsePort(getField(parts, 10));
  const ipv6Port = parsePort(getField(parts, 11));
  const isEditorWorld = parseFlag(getField(parts, 12));
  const xboxReachability = parseFlag(getField(parts, 13));
  const isOnlineMode = parseOnlineMode(getField(parts, 14));

  return {
    edition,
    motd,
    protocolVersion,
    versionName,
    currentPlayers,
    maxPlayers,
    serverGuid,
    worldName,
    gamemode,
    isJoinableThroughServerScreen,
    ipv4Port,
    ipv6Port,
    isEditorWorld,
    xboxReachability,
    isOnlineMode,
    latencyMs,
    rawPayload: payloadStr,
  };
}

export async function pingBedrockRakNet(
  host: string,
  port = 19132,
  timeoutMs = 5000,
): Promise<BedrockServerMetrics> {
  await validateTargetHost(host);

  let targetIp = host;
  const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  const isIpv6 = host.includes(":");

  if (!isIpv4 && !isIpv6) {
    try {
      const records = await Deno.resolveDns(host, "A");
      if (records && records.length > 0) {
        targetIp = records[0];
      }
    } catch (e) {
      Log.debug(TAG, `DNS resolution for ${host} fell back to raw host:`, e);
    }
  }

  // @ts-ignore Deno.listenDatagram unstable-net
  const socket = Deno.listenDatagram({
    port: 0,
    transport: "udp",
    hostname: "0.0.0.0",
  });

  const startTime = performance.now();
  const pingPacket = buildUnconnectedPingPacket(BigInt(Date.now()));

  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    await socket.send(pingPacket, {
      transport: "udp",
      hostname: targetIp,
      port,
    });

    let rejectTimeout!: (reason: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    timerId = setTimeout(() => {
      rejectTimeout(new Error(`RakNet ping timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const receivePromise = (async (): Promise<BedrockServerMetrics> => {
      for await (const [data, remoteAddr] of socket) {
        if (remoteAddr.transport !== "udp" || remoteAddr.hostname !== targetIp || remoteAddr.port !== port) {
          continue;
        }

        if (data.length > 0 && data[0] === 0x1c) {
          // ID_UNCONNECTED_PONG (0x1c)
          const latencyMs = Math.round(performance.now() - startTime);

          let payloadStr = "";
          if (data.length >= 35) {
            const strLen = (data[33] << 8) | data[34];
            if (data.length >= 35 + strLen && strLen > 0) {
              payloadStr = new TextDecoder().decode(data.subarray(35, 35 + strLen));
            } else {
              payloadStr = new TextDecoder().decode(data.subarray(35));
            }
          }

          if (!payloadStr.startsWith("MCPE;")) {
            const fullDecoded = new TextDecoder().decode(data);
            const mcpeIdx = fullDecoded.indexOf("MCPE;");
            if (mcpeIdx !== -1) {
              payloadStr = fullDecoded.slice(mcpeIdx);
            }
          }

          return parseBedrockPongPayload(payloadStr, latencyMs);
        }
      }
      throw new Error("Socket closed without receiving pong");
    })();

    return await Promise.race([receivePromise, timeoutPromise]);
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
    try {
      socket.close();
    } catch {
      // Ignore socket closing errors
    }
  }
}

export function buildRakNetEmbed(
  host: string,
  port: number,
  metrics: BedrockServerMetrics,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(t("mcping.raknet_title"))
    .setColor(0x46FF27)
    .addFields(
      {
        name: t("mcping.field_ip"),
        value: `\`${host}:${port}\``,
        inline: true,
      },
      {
        name: t("mcping.field_version"),
        value: metrics.protocolVersion !== "-"
          ? `\`${metrics.versionName}\` (Proto: \`${metrics.protocolVersion}\`)`
          : `\`${metrics.versionName}\``,
        inline: true,
      },
      {
        name: t("mcping.field_players"),
        value: `\`${metrics.currentPlayers} / ${metrics.maxPlayers}\``,
        inline: true,
      },
      {
        name: t("mcping.field_motd"),
        value: `\`\`\`\n${metrics.motd || "-"}\n\`\`\``,
        inline: false,
      },
    );

  if (metrics.worldName !== null && metrics.worldName.trim() !== "") {
    embed.addFields({
      name: t("mcping.field_sub_motd"),
      value: `\`${metrics.worldName}\``,
      inline: true,
    });
  }

  if (metrics.gamemode !== null && metrics.gamemode.trim() !== "") {
    embed.addFields({
      name: t("mcping.field_gamemode"),
      value: `\`${metrics.gamemode}\``,
      inline: true,
    });
  }

  embed.addFields({
    name: t("mcping.field_latency"),
    value: `\`${metrics.latencyMs} ms\``,
    inline: true,
  });

  if (metrics.ipv4Port !== null || metrics.ipv6Port !== null) {
    const portParts: string[] = [];
    if (metrics.ipv4Port !== null) portParts.push(`IPv4: \`${metrics.ipv4Port}\``);
    if (metrics.ipv6Port !== null) portParts.push(`IPv6: \`${metrics.ipv6Port}\``);
    embed.addFields({
      name: t("mcping.field_ports"),
      value: portParts.join(" • "),
      inline: true,
    });
  }

  if (metrics.isOnlineMode !== null || metrics.xboxReachability !== null) {
    const authParts: string[] = [];
    if (metrics.isOnlineMode !== null) {
      authParts.push(metrics.isOnlineMode ? t("mcping.auth_online") : t("mcping.auth_offline"));
    }
    if (metrics.xboxReachability !== null) {
      const reachText = metrics.xboxReachability
        ? t("mcping.xbox_service_connected")
        : t("mcping.xbox_service_unreachable");
      authParts.push(`(Xbox Service: ${reachText})`);
    }
    embed.addFields({
      name: t("mcping.field_auth"),
      value: authParts.join(" "),
      inline: true,
    });
  }

  if (metrics.isJoinableThroughServerScreen !== null || metrics.isEditorWorld !== null) {
    const flagParts: string[] = [];
    if (metrics.isJoinableThroughServerScreen !== null) {
      flagParts.push(`Joinable: \`${metrics.isJoinableThroughServerScreen ? t("mcping.yes") : t("mcping.no")}\``);
    }
    if (metrics.isEditorWorld !== null) {
      flagParts.push(`Editor: \`${metrics.isEditorWorld ? t("mcping.yes") : t("mcping.no")}\``);
    }
    embed.addFields({
      name: t("mcping.field_flags"),
      value: flagParts.join(" • "),
      inline: true,
    });
  }

  if (metrics.serverGuid !== null && metrics.serverGuid.trim() !== "") {
    embed.addFields({
      name: t("mcping.field_guid"),
      value: `\`${metrics.serverGuid}\``,
      inline: false,
    });
  }

  embed.setFooter({
    text: `${t("mcping.footer_bedrock_raknet")} • ${metrics.latencyMs} ms`,
  }).setTimestamp();

  return embed;
}
