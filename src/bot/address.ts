export interface ParsedAddress {
  host: string;
  port?: number;
}

/**
 * Parses user input into a target host and optional port.
 * Handles:
 * - Combined host:port (e.g. play.example.com:25566, 1.2.3.4:19132)
 * - Bracketed IPv6 with or without port (e.g. [::1]:19132, [2001:db8::1])
 * - Plain IPv6 without brackets (e.g. ::1, 2001:db8::1)
 * - Standard hostname / IPv4 without port
 */
export function parseHostAndPort(rawInput: string): ParsedAddress {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { host: "" };
  }

  if (trimmed.startsWith("[")) {
    const closingBracket = trimmed.indexOf("]");
    if (closingBracket !== -1) {
      const hostPart = trimmed.slice(1, closingBracket).trim();
      const afterBracket = trimmed.slice(closingBracket + 1).trim();
      if (afterBracket.startsWith(":")) {
        const portStr = afterBracket.slice(1).trim();
        const parsedPort = parseInt(portStr, 10);
        if (!isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
          return { host: hostPart, port: parsedPort };
        }
      }
      return { host: hostPart };
    }
  }

  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount > 1) {
    return { host: trimmed };
  }

  if (colonCount === 1) {
    const colonIndex = trimmed.indexOf(":");
    const hostPart = trimmed.slice(0, colonIndex).trim();
    const portStr = trimmed.slice(colonIndex + 1).trim();
    const parsedPort = parseInt(portStr, 10);
    if (!isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
      return { host: hostPart, port: parsedPort };
    }
    return { host: hostPart };
  }

  return { host: trimmed };
}

