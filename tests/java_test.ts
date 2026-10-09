import {
  writeVarInt,
  writeString,
  buildHandshakePacket,
  buildStatusRequestPacket,
  parseJavaMotd,
  decodeFaviconBuffer,
  buildJavaEmbed,
} from "../src/bot/java.ts";

Deno.test("Java SLP: VarInt encoding", () => {
  // 0 -> [0x00]
  const v0 = writeVarInt(0);
  if (v0.length !== 1 || v0[0] !== 0x00) throw new Error("VarInt 0 mismatch");

  // 1 -> [0x01]
  const v1 = writeVarInt(1);
  if (v1.length !== 1 || v1[0] !== 0x01) throw new Error("VarInt 1 mismatch");

  // 127 -> [0x7f]
  const v127 = writeVarInt(127);
  if (v127.length !== 1 || v127[0] !== 0x7f) throw new Error("VarInt 127 mismatch");

  // 128 -> [0x80, 0x01]
  const v128 = writeVarInt(128);
  if (v128.length !== 2 || v128[0] !== 0x80 || v128[1] !== 0x01) throw new Error("VarInt 128 mismatch");

  // 255 -> [0xff, 0x01]
  const v255 = writeVarInt(255);
  if (v255.length !== 2 || v255[0] !== 0xff || v255[1] !== 0x01) throw new Error("VarInt 255 mismatch");

  // 767 -> [0xff, 0x05]
  const v767 = writeVarInt(767);
  if (v767.length !== 2 || v767[0] !== 0xff || v767[1] !== 0x05) throw new Error("VarInt 767 mismatch");
});

Deno.test("Java SLP: Packet building", () => {
  const handshake = buildHandshakePacket("localhost", 25565, 767);
  if (handshake.length <= 0) throw new Error("Handshake packet empty");

  const statusReq = buildStatusRequestPacket();
  if (statusReq.length !== 2 || statusReq[0] !== 0x01 || statusReq[1] !== 0x00) {
    throw new Error(`Status request packet mismatch: ${statusReq}`);
  }
});

Deno.test("Java SLP: parseJavaMotd handles plain string and complex components", () => {
  // Simple string
  const m1 = parseJavaMotd("§aWelcome to §bHypixel!§r");
  if (m1 !== "Welcome to Hypixel!") throw new Error(`m1 failed: "${m1}"`);

  // Text component object with extra array
  const m2 = parseJavaMotd({
    text: "§6Sanctum ",
    extra: [
      { text: "§fServer ", color: "white" },
      { text: "§a[1.21.1]", color: "green" },
    ],
  });
  if (m2 !== "Sanctum Server [1.21.1]") throw new Error(`m2 failed: "${m2}"`);

  // Deeply nested text components
  const m3 = parseJavaMotd({
    text: "Line 1\n",
    extra: [
      {
        text: "Line 2 - ",
        extra: [
          { text: "Deep nested" },
        ],
      },
    ],
  });
  if (m3 !== "Line 1\nLine 2 - Deep nested") throw new Error(`m3 failed: "${m3}"`);

  // Translate component
  const m4 = parseJavaMotd({
    translate: "chat.type.announcement",
    with: ["Server", "Rebooting"],
  });
  if (m4 !== "chat.type.announcement Server Rebooting") throw new Error(`m4 failed: "${m4}"`);

  // Array of components
  const m5 = parseJavaMotd([
    { text: "Part 1 " },
    { text: "Part 2" },
  ]);
  if (m5 !== "Part 1 Part 2") throw new Error(`m5 failed: "${m5}"`);
});

Deno.test("Java SLP: decodeFaviconBuffer handles base64 data URLs", () => {
  // 1x1 transparent PNG
  const validDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const buffer = decodeFaviconBuffer(validDataUrl);
  if (!buffer || buffer.length === 0) throw new Error("Failed to decode valid favicon");

  // Verify PNG header: 0x89 0x50 0x4E 0x47
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47) {
    throw new Error("Favicon buffer lacks PNG header");
  }

  // Null/empty test
  if (decodeFaviconBuffer(null) !== null) throw new Error("Expected null for null input");
  if (decodeFaviconBuffer("") !== null) throw new Error("Expected null for empty input");
});

Deno.test("Java SLP: buildJavaEmbed creates embed with simplified footer and optional attachment", () => {
  const pngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const faviconBuffer = decodeFaviconBuffer(pngDataUrl);

  const { embed, attachment } = buildJavaEmbed({
    host: "mc.hypixel.net",
    port: 25565,
    originalHost: "hypixel.net",
    versionName: "1.21.1",
    protocolVersion: 767,
    onlinePlayers: 45000,
    maxPlayers: 100000,
    motd: "Hypixel Network",
    latencyMs: 35,
    faviconBuffer,
    srvResolved: true,
  });

  const json = embed.toJSON();
  if (json.footer?.text !== "Minecraft Java Edition") {
    throw new Error(`Unexpected footer: ${json.footer?.text}`);
  }
  if (!attachment) {
    throw new Error("Attachment should be created when faviconBuffer is present");
  }
  if (json.thumbnail?.url !== "attachment://favicon.png") {
    throw new Error(`Unexpected thumbnail: ${json.thumbnail?.url}`);
  }
});

