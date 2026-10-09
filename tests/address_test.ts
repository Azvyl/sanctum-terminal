import { parseHostAndPort } from "../src/bot/address.ts";

Deno.test("parseHostAndPort: extracts host and port correctly", () => {
  // Common host:port
  const r1 = parseHostAndPort("play.example.com:25566");
  if (r1.host !== "play.example.com" || r1.port !== 25566) {
    throw new Error(`Failed r1: ${JSON.stringify(r1)}`);
  }

  // Bedrock host:port
  const r2 = parseHostAndPort("mc.hypixel.net:19132");
  if (r2.host !== "mc.hypixel.net" || r2.port !== 19132) {
    throw new Error(`Failed r2: ${JSON.stringify(r2)}`);
  }

  // IPv4 with port
  const r3 = parseHostAndPort("192.168.1.1:25565");
  if (r3.host !== "192.168.1.1" || r3.port !== 25565) {
    throw new Error(`Failed r3: ${JSON.stringify(r3)}`);
  }

  // Bracketed IPv6 with port
  const r4 = parseHostAndPort("[::1]:19132");
  if (r4.host !== "::1" || r4.port !== 19132) {
    throw new Error(`Failed r4: ${JSON.stringify(r4)}`);
  }

  // Bracketed IPv6 with port (full address)
  const r5 = parseHostAndPort("[2001:db8::1]:25565");
  if (r5.host !== "2001:db8::1" || r5.port !== 25565) {
    throw new Error(`Failed r5: ${JSON.stringify(r5)}`);
  }

  // Bracketed IPv6 without port
  const r6 = parseHostAndPort("[2001:db8::1]");
  if (r6.host !== "2001:db8::1" || r6.port !== undefined) {
    throw new Error(`Failed r6: ${JSON.stringify(r6)}`);
  }

  // Plain IPv6 without brackets (multiple colons)
  const r7 = parseHostAndPort("::1");
  if (r7.host !== "::1" || r7.port !== undefined) {
    throw new Error(`Failed r7: ${JSON.stringify(r7)}`);
  }

  const r8 = parseHostAndPort("2001:db8::1");
  if (r8.host !== "2001:db8::1" || r8.port !== undefined) {
    throw new Error(`Failed r8: ${JSON.stringify(r8)}`);
  }

  // Plain domain without port
  const r9 = parseHostAndPort("play.hypixel.net");
  if (r9.host !== "play.hypixel.net" || r9.port !== undefined) {
    throw new Error(`Failed r9: ${JSON.stringify(r9)}`);
  }

  // Whitespace trimming
  const r10 = parseHostAndPort("  [::1]:25565  ");
  if (r10.host !== "::1" || r10.port !== 25565) {
    throw new Error(`Failed r10: ${JSON.stringify(r10)}`);
  }

  // Empty string
  const r11 = parseHostAndPort("   ");
  if (r11.host !== "" || r11.port !== undefined) {
    throw new Error(`Failed r11: ${JSON.stringify(r11)}`);
  }

  // Invalid port string fallback
  const r12 = parseHostAndPort("example.com:abc");
  if (r12.host !== "example.com" || r12.port !== undefined) {
    throw new Error(`Failed r12: ${JSON.stringify(r12)}`);
  }
});

