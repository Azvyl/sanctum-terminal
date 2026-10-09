import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { Buffer } from "node:buffer";
import { Log } from "../logger.ts";
import { t } from "../i18n/index.ts";
import { validateTargetHost } from "./ssrf.ts";
import { cleanMinecraftFormatting } from "./raknet.ts";

const TAG = "JavaSLP";

export interface JavaServerMetrics {
  host: string;
  port: number;
  originalHost: string;
  originalPort?: number;
  versionName: string;
  protocolVersion: number;
  onlinePlayers: number;
  maxPlayers: number;
  motd: string;
  latencyMs: number;
  faviconBuffer: Uint8Array | null;
  srvResolved: boolean;
}

export function writeVarInt(value: number): Uint8Array {
  const bytes: number[] = [];
  let val = value >>> 0;
  while (true) {
    if ((val & ~0x7F) === 0) {
      bytes.push(val);
      break;
    }
    bytes.push((val & 0x7F) | 0x80);
    val = val >>> 7;
  }
  return new Uint8Array(bytes);
}

export class TcpReader {
  private buffer = new Uint8Array(8192);
  private head = 0;
  private tail = 0;

  constructor(private conn: Deno.Conn) { }

  private async fill(): Promise<boolean> {
    if (this.head < this.tail) {
      this.buffer.copyWithin(0, this.head, this.tail);
      this.tail -= this.head;
      this.head = 0;
    } else {
      this.head = 0;
      this.tail = 0;
    }
    const n = await this.conn.read(this.buffer.subarray(this.tail));
    if (n === null || n === 0) return false;
    this.tail += n;
    return true;
  }

  public async readByte(): Promise<number> {
    if (this.head >= this.tail) {
      const ok = await this.fill();
      if (!ok) throw new Error("Unexpected EOF reading byte from server");
    }
    return this.buffer[this.head++];
  }

  public async readVarInt(): Promise<number> {
    let numRead = 0;
    let result = 0;
    let byte: number;
    do {
      byte = await this.readByte();
      const value = byte & 0x7F;
      result |= (value << (7 * numRead));
      numRead++;
      if (numRead > 5) {
        throw new Error("VarInt exceeds 5 bytes limit");
      }
    } while ((byte & 0x80) !== 0);
    return result;
  }

  public async readExact(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const available = this.tail - this.head;
      if (available > 0) {
        const toCopy = Math.min(available, length - offset);
        result.set(this.buffer.subarray(this.head, this.head + toCopy), offset);
        this.head += toCopy;
        offset += toCopy;
      } else {
        const ok = await this.fill();
        if (!ok) {
          throw new Error(`Unexpected EOF reading ${length} bytes (received ${offset})`);
        }
      }
    }
    return result;
  }
}

export function writeString(str: string): Uint8Array {
  const encoded = new TextEncoder().encode(str);
  const lenVarInt = writeVarInt(encoded.length);
  const result = new Uint8Array(lenVarInt.length + encoded.length);
  result.set(lenVarInt, 0);
  result.set(encoded, lenVarInt.length);
  return result;
}

export function buildHandshakePacket(host: string, port: number, protocolVersion = 767): Uint8Array {
  const packetId = writeVarInt(0x00);
  const proto = writeVarInt(protocolVersion);
  const hostStr = writeString(host);
  const portBytes = new Uint8Array(2);
  const portView = new DataView(portBytes.buffer);
  portView.setUint16(0, port, false);
  const nextState = writeVarInt(1);

  const payloadLen = packetId.length + proto.length + hostStr.length + portBytes.length + nextState.length;
  const payload = new Uint8Array(payloadLen);
  let offset = 0;
  payload.set(packetId, offset); offset += packetId.length;
  payload.set(proto, offset); offset += proto.length;
  payload.set(hostStr, offset); offset += hostStr.length;
  payload.set(portBytes, offset); offset += portBytes.length;
  payload.set(nextState, offset);

  const lengthVarInt = writeVarInt(payload.length);
  const packet = new Uint8Array(lengthVarInt.length + payload.length);
  packet.set(lengthVarInt, 0);
  packet.set(payload, lengthVarInt.length);
  return packet;
}

export function buildStatusRequestPacket(): Uint8Array {
  // Packet ID 0x00, total length 1 byte
  return new Uint8Array([0x01, 0x00]);
}

/**
 * Recursively parses and flattens Minecraft chat/MOTD component objects or strings
 * into plain text free of color/formatting codes.
 */
export function parseJavaMotd(description: unknown): string {
  function extractText(node: unknown): string {
    if (node === null || node === undefined) return "";
    if (typeof node === "string") return node;
    if (typeof node === "number" || typeof node === "boolean") return String(node);
    if (Array.isArray(node)) {
      return node.map(extractText).join("");
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      let result = "";
      if (typeof obj.text === "string") {
        result += obj.text;
      }
      if (Array.isArray(obj.extra)) {
        result += obj.extra.map(extractText).join("");
      }
      if (typeof obj.translate === "string") {
        result += obj.translate;
        if (Array.isArray(obj.with)) {
          result += " " + obj.with.map(extractText).join(" ");
        } else if (Array.isArray(obj.args)) {
          result += " " + obj.args.map(extractText).join(" ");
        }
      }
      return result;
    }
    return "";
  }

  const rawText = extractText(description);
  return cleanMinecraftFormatting(rawText);
}

/**
 * Decodes base64 favicon data URL into a binary Uint8Array buffer.
 */
export function decodeFaviconBuffer(faviconStr: unknown): Uint8Array | null {
  if (typeof faviconStr !== "string" || !faviconStr.trim()) return null;
  const commaIdx = faviconStr.indexOf(",");
  const base64Data = commaIdx !== -1 ? faviconStr.slice(commaIdx + 1).trim() : faviconStr.trim();
  try {
    const binaryStr = atob(base64Data);
    const buffer = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      buffer[i] = binaryStr.charCodeAt(i);
    }
    return buffer;
  } catch (err) {
    Log.debug(TAG, "Failed decoding base64 favicon:", err);
    return null;
  }
}

export interface ResolvedJavaTarget {
  targetHost: string;
  targetPort: number;
  srvResolved: boolean;
}

export async function resolveJavaServerTarget(
  host: string,
  port?: number,
): Promise<ResolvedJavaTarget> {
  const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  const isIpv6 = host.includes(":");

  if (port !== undefined || isIpv4 || isIpv6) {
    return {
      targetHost: host,
      targetPort: port ?? 25565,
      srvResolved: false,
    };
  }

  const srvDomain = `_minecraft._tcp.${host}`;
  try {
    const records = await Deno.resolveDns(srvDomain, "SRV");
    if (records && records.length > 0) {
      records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      const targetHost = records[0].target.replace(/\.+$/, "");
      const targetPort = records[0].port;
      Log.debug(TAG, `DNS SRV resolved ${srvDomain} -> ${targetHost}:${targetPort}`);
      return {
        targetHost,
        targetPort,
        srvResolved: true,
      };
    }
  } catch (err) {
    Log.debug(TAG, `DNS SRV lookup skipped or failed for ${srvDomain}:`, err);
  }

  return {
    targetHost: host,
    targetPort: 25565,
    srvResolved: false,
  };
}

export async function pingJava(
  host: string,
  port?: number,
  timeoutMs = 5000,
): Promise<JavaServerMetrics> {
  await validateTargetHost(host);

  const { targetHost, targetPort, srvResolved } = await resolveJavaServerTarget(host, port);

  if (targetHost !== host) {
    await validateTargetHost(targetHost);
  }

  const startTime = performance.now();
  let conn: Deno.Conn | undefined = undefined;
  let timerId: ReturnType<typeof setTimeout> | undefined;

  try {
    let rejectTimeout!: (reason: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    timerId = setTimeout(() => {
      rejectTimeout(new Error(`Java SLP connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const connectAndPing = async (): Promise<JavaServerMetrics> => {
      conn = await Deno.connect({
        hostname: targetHost,
        port: targetPort,
      });

      const handshake = buildHandshakePacket(host, targetPort, 767);
      const statusRequest = buildStatusRequestPacket();

      await conn.write(handshake);
      await conn.write(statusRequest);

      const reader = new TcpReader(conn);
      const packetLength = await reader.readVarInt();
      if (packetLength <= 0) {
        throw new Error("Invalid SLP packet length received from server");
      }

      const packetId = await reader.readVarInt();
      if (packetId !== 0x00) {
        throw new Error(`Unexpected SLP response packet ID: 0x${packetId.toString(16)}`);
      }

      const jsonLength = await reader.readVarInt();
      const MAX_ALLOWED_PACKET_BYTES = 512 * 1024;

      if (jsonLength <= 0 || jsonLength > MAX_ALLOWED_PACKET_BYTES) {
        throw new Error(`SLP payload size is invalid or exceeds the security limit: ${jsonLength} bytes..`);
      }

      const jsonBytes = await reader.readExact(jsonLength);
      const latencyMs = Math.max(1, Math.round(performance.now() - startTime));

      const jsonStr = new TextDecoder().decode(jsonBytes);
      const data = JSON.parse(jsonStr);

      const versionName = data.version?.name || "Unknown";
      const protocolVersion = typeof data.version?.protocol === "number" ? data.version.protocol : 0;
      const onlinePlayers = typeof data.players?.online === "number" ? data.players.online : 0;
      const maxPlayers = typeof data.players?.max === "number" ? data.players.max : 0;
      const motd = parseJavaMotd(data.description);
      const faviconBuffer = decodeFaviconBuffer(data.favicon);

      return {
        host: targetHost,
        port: targetPort,
        originalHost: host,
        originalPort: port,
        versionName,
        protocolVersion,
        onlinePlayers,
        maxPlayers,
        motd,
        latencyMs,
        faviconBuffer,
        srvResolved,
      };
    };

    return await Promise.race([connectAndPing(), timeoutPromise]);
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
    if (conn) {
      try {
        (conn as Deno.Conn).close();
      } catch {
        // Ignore socket close errors
      }
    }
  }
}

export function buildJavaEmbed(
  metrics: JavaServerMetrics,
): { embed: EmbedBuilder; attachment?: AttachmentBuilder } {
  const displayAddress = metrics.srvResolved
    ? `\`${metrics.originalHost}\` (\`${metrics.host}:${metrics.port}\`)`
    : `\`${metrics.host}:${metrics.port}\``;

  const embed = new EmbedBuilder()
    .setTitle(t("mcping.java_title"))
    .setColor(0x46FF27)
    .addFields(
      {
        name: t("mcping.field_ip"),
        value: displayAddress,
        inline: true,
      },
      {
        name: t("mcping.field_version"),
        value: metrics.protocolVersion > 0
          ? `\`${metrics.versionName}\` (Proto: \`${metrics.protocolVersion}\`)`
          : `\`${metrics.versionName}\``,
        inline: true,
      },
      {
        name: t("mcping.field_players"),
        value: `\`${metrics.onlinePlayers} / ${metrics.maxPlayers}\``,
        inline: true,
      },
      {
        name: t("mcping.field_motd"),
        value: `\`\`\`\n${metrics.motd || "-"}\n\`\`\``,
        inline: false,
      },
      {
        name: t("mcping.field_latency"),
        value: `\`${metrics.latencyMs} ms\``,
        inline: true,
      },
    )
    .setFooter({
      text: t("mcping.footer_java"),
    })
    .setTimestamp();

  let attachment: AttachmentBuilder | undefined;
  if (metrics.faviconBuffer && metrics.faviconBuffer.length > 0) {
    attachment = new AttachmentBuilder(Buffer.from(metrics.faviconBuffer), { name: "favicon.png" });
    embed.setThumbnail("attachment://favicon.png");
  }

  return { embed, attachment };
}
