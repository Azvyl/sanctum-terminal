import {
  isPrivateOrRestrictedIp,
  isPrivateOrRestrictedIpv4,
  isPrivateOrRestrictedIpv6,
  validateTargetHost,
  SsrfBlockedError,
} from "../src/bot/ssrf.ts";

Deno.test("SSRF: IPv4 restricted checks", () => {
  // Loopback (127.0.0.0/8)
  if (!isPrivateOrRestrictedIpv4("127.0.0.1")) throw new Error("127.0.0.1 must be restricted");
  if (!isPrivateOrRestrictedIpv4("127.255.255.254")) throw new Error("127.255.255.254 must be restricted");

  // Unspecified (0.0.0.0/8)
  if (!isPrivateOrRestrictedIpv4("0.0.0.0")) throw new Error("0.0.0.0 must be restricted");

  // Private LAN (10.0.0.0/8)
  if (!isPrivateOrRestrictedIpv4("10.0.0.1")) throw new Error("10.0.0.1 must be restricted");
  if (!isPrivateOrRestrictedIpv4("10.254.1.1")) throw new Error("10.254.1.1 must be restricted");

  // Private LAN (172.16.0.0/12: 172.16.0.0 - 172.31.255.255)
  if (!isPrivateOrRestrictedIpv4("172.16.0.1")) throw new Error("172.16.0.1 must be restricted");
  if (!isPrivateOrRestrictedIpv4("172.31.255.254")) throw new Error("172.31.255.254 must be restricted");
  if (isPrivateOrRestrictedIpv4("172.15.255.255")) throw new Error("172.15.255.255 must NOT be restricted");
  if (isPrivateOrRestrictedIpv4("172.32.0.1")) throw new Error("172.32.0.1 must NOT be restricted");

  // Private LAN (192.168.0.0/16)
  if (!isPrivateOrRestrictedIpv4("192.168.1.1")) throw new Error("192.168.1.1 must be restricted");
  if (!isPrivateOrRestrictedIpv4("192.168.254.254")) throw new Error("192.168.254.254 must be restricted");
  if (isPrivateOrRestrictedIpv4("192.169.1.1")) throw new Error("192.169.1.1 must NOT be restricted");

  // Link-local & Cloud Metadata (169.254.0.0/16)
  if (!isPrivateOrRestrictedIpv4("169.254.169.254")) throw new Error("169.254.169.254 must be restricted");
  if (!isPrivateOrRestrictedIpv4("169.254.1.1")) throw new Error("169.254.1.1 must be restricted");

  // Broadcast (255.255.255.255)
  if (!isPrivateOrRestrictedIpv4("255.255.255.255")) throw new Error("255.255.255.255 must be restricted");

  // Public IPv4 (allowed)
  if (isPrivateOrRestrictedIpv4("8.8.8.8")) throw new Error("8.8.8.8 must be allowed");
  if (isPrivateOrRestrictedIpv4("1.1.1.1")) throw new Error("1.1.1.1 must be allowed");
  if (isPrivateOrRestrictedIpv4("104.21.45.1")) throw new Error("104.21.45.1 must be allowed");
});

Deno.test("SSRF: IPv6 restricted checks", () => {
  // Loopback (::1)
  if (!isPrivateOrRestrictedIpv6("::1")) throw new Error("::1 must be restricted");
  if (!isPrivateOrRestrictedIpv6("0:0:0:0:0:0:0:1")) throw new Error("0:0:0:0:0:0:0:1 must be restricted");

  // Unspecified (::)
  if (!isPrivateOrRestrictedIpv6("::")) throw new Error(":: must be restricted");

  // Link-local (fe80::/10)
  if (!isPrivateOrRestrictedIpv6("fe80::1")) throw new Error("fe80::1 must be restricted");
  if (!isPrivateOrRestrictedIpv6("fe80::a00:27ff:fe37:9c32")) throw new Error("fe80 link-local must be restricted");

  // Unique Local Address / ULA (fc00::/7)
  if (!isPrivateOrRestrictedIpv6("fc00::1")) throw new Error("fc00::1 must be restricted");
  if (!isPrivateOrRestrictedIpv6("fd12:3456:789a::1")) throw new Error("fd12::1 must be restricted");

  // IPv4-mapped IPv6
  if (!isPrivateOrRestrictedIpv6("::ffff:127.0.0.1")) throw new Error("::ffff:127.0.0.1 must be restricted");
  if (!isPrivateOrRestrictedIpv6("::ffff:192.168.1.1")) throw new Error("::ffff:192.168.1.1 must be restricted");
  if (!isPrivateOrRestrictedIpv6("::ffff:169.254.169.254")) throw new Error("::ffff:169.254.169.254 must be restricted");
  if (isPrivateOrRestrictedIpv6("::ffff:8.8.8.8")) throw new Error("::ffff:8.8.8.8 must NOT be restricted");

  // Public IPv6 (allowed)
  if (isPrivateOrRestrictedIpv6("2606:4700:4700::1111")) throw new Error("Cloudflare DNS IPv6 must be allowed");
  if (isPrivateOrRestrictedIpv6("2001:4860:4860::8888")) throw new Error("Google DNS IPv6 must be allowed");
});

Deno.test("SSRF: validateTargetHost throws SsrfBlockedError on forbidden targets", async () => {
  // Localhost
  try {
    await validateTargetHost("localhost");
    throw new Error("Should have thrown for localhost");
  } catch (e) {
    if (!(e instanceof SsrfBlockedError)) throw e;
  }

  // *.localhost
  try {
    await validateTargetHost("api.test.localhost");
    throw new Error("Should have thrown for test.localhost");
  } catch (e) {
    if (!(e instanceof SsrfBlockedError)) throw e;
  }

  // 127.0.0.1
  try {
    await validateTargetHost("127.0.0.1");
    throw new Error("Should have thrown for 127.0.0.1");
  } catch (e) {
    if (!(e instanceof SsrfBlockedError)) throw e;
  }

  // 192.168.1.100
  try {
    await validateTargetHost("192.168.1.100");
    throw new Error("Should have thrown for 192.168.1.100");
  } catch (e) {
    if (!(e instanceof SsrfBlockedError)) throw e;
  }

  // [::1]
  try {
    await validateTargetHost("[::1]");
    throw new Error("Should have thrown for [::1]");
  } catch (e) {
    if (!(e instanceof SsrfBlockedError)) throw e;
  }

  // Public IP literal should succeed without throwing
  const pub = await validateTargetHost("1.1.1.1");
  if (pub !== "1.1.1.1") throw new Error(`Unexpected result: ${pub}`);
});

