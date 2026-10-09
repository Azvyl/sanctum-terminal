import {
  parseBedrockPongPayload,
  buildRakNetEmbed,
  cleanMinecraftFormatting,
} from "../src/bot/raknet.ts";

Deno.test("RakNet: cleanMinecraftFormatting removes formatting codes", () => {
  const dirty = "§aDedicated §lServer§r §e§nWorld!§r §x§f§f§a§a§0§0Custom";
  const cleaned = cleanMinecraftFormatting(dirty);
  if (cleaned !== "Dedicated Server World! Custom") {
    throw new Error(`Expected clean text, got: "${cleaned}"`);
  }
});

Deno.test("RakNet: cleanMinecraftFormatting removes modern, extended, hex, and unicode glyph formatting", () => {
  const dirty = "§aDedicated §lServer §gSpecial Gold §#FF55AAHex §x§f§f§5§5§a§aBungee \uE010World! §0Custom";
  const cleaned = cleanMinecraftFormatting(dirty);
  if (cleaned !== "Dedicated Server Special Gold Hex Bungee World! Custom") {
    throw new Error(`Expected clean text, got: "${cleaned}"`);
  }
});

Deno.test("RakNet: parses modern BDS 15-field payload correctly", () => {
  // MCPE;Dedicated Server;712;1.21.20;5;20;12345678901234;Survival World;Survival;1;19132;19133;0;1;0
  const payload = "MCPE;Dedicated Server;712;1.21.20;5;20;12345678901234;Survival World;Survival;1;19132;19133;0;1;0";
  const metrics = parseBedrockPongPayload(payload, 42);

  if (metrics.edition !== "MCPE") throw new Error(`Wrong edition: ${metrics.edition}`);
  if (metrics.motd !== "Dedicated Server") throw new Error(`Wrong motd: ${metrics.motd}`);
  if (metrics.protocolVersion !== "712") throw new Error(`Wrong protocol: ${metrics.protocolVersion}`);
  if (metrics.versionName !== "1.21.20") throw new Error(`Wrong version: ${metrics.versionName}`);
  if (metrics.currentPlayers !== 5) throw new Error(`Wrong current players: ${metrics.currentPlayers}`);
  if (metrics.maxPlayers !== 20) throw new Error(`Wrong max players: ${metrics.maxPlayers}`);
  if (metrics.serverGuid !== "12345678901234") throw new Error(`Wrong guid: ${metrics.serverGuid}`);
  if (metrics.worldName !== "Survival World") throw new Error(`Wrong world: ${metrics.worldName}`);
  if (metrics.gamemode !== "Survival") throw new Error(`Wrong gamemode: ${metrics.gamemode}`);
  if (metrics.isJoinableThroughServerScreen !== true) throw new Error("Joinable should be true");
  if (metrics.ipv4Port !== 19132) throw new Error(`Wrong ipv4Port: ${metrics.ipv4Port}`);
  if (metrics.ipv6Port !== 19133) throw new Error(`Wrong ipv6Port: ${metrics.ipv6Port}`);
  if (metrics.isEditorWorld !== false) throw new Error("isEditorWorld should be false");
  if (metrics.xboxReachability !== true) throw new Error("xboxReachability should be true (1)");
  if (metrics.isOnlineMode !== true) throw new Error("isOnlineMode should be true (0 = online mode)");
  if (metrics.latencyMs !== 42) throw new Error(`Wrong latency: ${metrics.latencyMs}`);

  // Test dynamic embed building
  const embed = buildRakNetEmbed("play.example.com", 19132, metrics);
  const json = embed.toJSON();
  if (!json.footer?.text.includes("Minecraft Bedrock Edition (RakNet)")) {
    throw new Error(`Unexpected footer: ${json.footer?.text}`);
  }
  // All fields should be present in 15-field payload
  const fieldNames = json.fields?.map((f) => f.name) || [];
  if (!fieldNames.some((n) => n.includes("Port"))) throw new Error("Expected ports field");
  if (!fieldNames.some((n) => n.includes("GUID"))) throw new Error("Expected GUID field");
});

Deno.test("RakNet: parses legacy / limited field payload with nullable fields", () => {
  // Legacy MCPE server sending only 6 fields: Edition;MOTD;Protocol;Version;Players;MaxPlayers
  const legacyPayload = "MCPE;Old School Server;38;0.14.0;2;10";
  const metrics = parseBedrockPongPayload(legacyPayload, 55);

  if (metrics.edition !== "MCPE") throw new Error(`Wrong edition: ${metrics.edition}`);
  if (metrics.motd !== "Old School Server") throw new Error(`Wrong motd: ${metrics.motd}`);
  if (metrics.protocolVersion !== "38") throw new Error(`Wrong proto: ${metrics.protocolVersion}`);
  if (metrics.versionName !== "0.14.0") throw new Error(`Wrong ver: ${metrics.versionName}`);
  if (metrics.currentPlayers !== 2) throw new Error(`Wrong players: ${metrics.currentPlayers}`);
  if (metrics.maxPlayers !== 10) throw new Error(`Wrong max players: ${metrics.maxPlayers}`);

  // All subsequent fields must be null (not false or misleading defaults)
  if (metrics.serverGuid !== null) throw new Error(`Expected null serverGuid, got ${metrics.serverGuid}`);
  if (metrics.worldName !== null) throw new Error(`Expected null worldName, got ${metrics.worldName}`);
  if (metrics.gamemode !== null) throw new Error(`Expected null gamemode, got ${metrics.gamemode}`);
  if (metrics.isJoinableThroughServerScreen !== null) {
    throw new Error(`Expected null isJoinable, got ${metrics.isJoinableThroughServerScreen}`);
  }
  if (metrics.ipv4Port !== null) throw new Error(`Expected null ipv4Port, got ${metrics.ipv4Port}`);
  if (metrics.ipv6Port !== null) throw new Error(`Expected null ipv6Port, got ${metrics.ipv6Port}`);
  if (metrics.isEditorWorld !== null) throw new Error(`Expected null isEditorWorld, got ${metrics.isEditorWorld}`);
  if (metrics.xboxReachability !== null) throw new Error(`Expected null xboxReachability, got ${metrics.xboxReachability}`);
  if (metrics.isOnlineMode !== null) throw new Error(`Expected null isOnlineMode, got ${metrics.isOnlineMode}`);

  // Test dynamic embed: should NOT include missing fields
  const embed = buildRakNetEmbed("play.example.com", 19132, metrics);
  const json = embed.toJSON();
  const fieldNames = json.fields?.map((f) => f.name) || [];

  if (fieldNames.some((n) => n.includes("Port"))) throw new Error("Did not expect Ports field for legacy server");
  if (fieldNames.some((n) => n.includes("GUID"))) throw new Error("Did not expect GUID field for legacy server");
  if (fieldNames.some((n) => n.includes("Autentikasi") || n.includes("Authentication"))) {
    throw new Error("Did not expect Auth field for legacy server");
  }
  if (fieldNames.some((n) => n.includes("Fitur") || n.includes("Feature Flags"))) {
    throw new Error("Did not expect Flags field for legacy server");
  }
});

