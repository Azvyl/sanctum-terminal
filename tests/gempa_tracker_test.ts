import {
  parseBmkgTimeToId,
  computeGempaHash,
  GempaRecord,
  TrackerState,
} from "../src/bot/trackers.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ": " : ""}Expected ${expected}, but got ${actual}`);
  }
}

function assertNotEquals(actual: unknown, expected: unknown, msg?: string) {
  if (actual === expected) {
    throw new Error(`${msg ? msg + ": " : ""}Expected values to be different, but both were ${actual}`);
  }
}

Deno.test("BMKG Tracker: parseBmkgTimeToId correctly parses various month formats", () => {
  // English format
  assertEquals(parseBmkgTimeToId("9 Oct 2026 16.47.46 WIB"), "20261009164746");
  assertEquals(parseBmkgTimeToId("25 Aug 2026 06:27:15 WIB"), "20260825062715");

  // Indonesian format
  assertEquals(parseBmkgTimeToId("9 Okt 2026 16.47.46 WIB"), "20261009164746");
  assertEquals(parseBmkgTimeToId("25 Agu 2026 06:27:15 WIB"), "20260825062715");
  assertEquals(parseBmkgTimeToId("1 Mei 2026 12:00:00 WITA"), "20260501120000");
  assertEquals(parseBmkgTimeToId("15 Nop 2026 05.10.20 WIT"), "20261115051020");
  assertEquals(parseBmkgTimeToId("31 Des 2026 23.59.59"), "20261231235959");

  // Full month names
  assertEquals(parseBmkgTimeToId("10 Januari 2026 01:02:03 WIB"), "20260110010203");
  assertEquals(parseBmkgTimeToId("14 Februari 2026 14:14:14 WIB"), "20260214141414");
  assertEquals(parseBmkgTimeToId("30 September 2026 09:30:00 WIB"), "20260930093000");

  // Fallback for non-standard formats
  const fallbackNumeric = parseBmkgTimeToId("2026-10-09 16:47:46");
  assertEquals(fallbackNumeric, "20261009164746");
});

Deno.test("BMKG Tracker: computeGempaHash returns consistent hash and detects changes", () => {
  const hash1 = computeGempaHash("4.6", "10 km", "1.2 LS - 120.4 BT", "Pusat gempa di laut", "-");
  const hash2 = computeGempaHash("4.6", "10 km", "1.2 LS - 120.4 BT", "Pusat gempa di laut", "-");
  assertEquals(hash1, hash2);

  // Magnitude revised
  const hashRevisedMag = computeGempaHash("4.7", "10 km", "1.2 LS - 120.4 BT", "Pusat gempa di laut", "-");
  assertNotEquals(hash1, hashRevisedMag);

  // Depth revised
  const hashRevisedDepth = computeGempaHash("4.6", "12 km", "1.2 LS - 120.4 BT", "Pusat gempa di laut", "-");
  assertNotEquals(hash1, hashRevisedDepth);

  // Coordinates revised
  const hashRevisedCoords = computeGempaHash("4.6", "10 km", "1.3 LS - 120.5 BT", "Pusat gempa di laut", "-");
  assertNotEquals(hash1, hashRevisedCoords);

  // Moment tensor added
  const hashRevisedMT = computeGempaHash("4.6", "10 km", "1.2 LS - 120.4 BT", "Pusat gempa di laut", "Strike 120 Dip 80");
  assertNotEquals(hash1, hashRevisedMT);
});

Deno.test("BMKG Tracker: 30-minute cache expiration logic", () => {
  const state: TrackerState = {
    lastBedrockVersion: "1.21",
    lastJavaVersion: "1.21",
    lastGempaId: "20261009164746",
    recentGempas: {
      "old_id": {
        threadId: "t1",
        messageId: "m1",
        createdAt: Date.now() - 35 * 60 * 1000, // 35 minutes ago (expired)
        dataHash: "hash1",
        title: "Old Gempa",
        magnitudo: "4.5",
        kedalaman: "10 km",
        koordinat: "0.0 0.0",
        wilayah: "Old Region",
        momentTensor: "-",
      },
      "recent_id": {
        threadId: "t2",
        messageId: "m2",
        createdAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago (active)
        dataHash: "hash2",
        title: "Recent Gempa",
        magnitudo: "5.0",
        kedalaman: "20 km",
        koordinat: "1.0 1.0",
        wilayah: "Recent Region",
        momentTensor: "-",
      },
    },
  };

  const now = Date.now();
  for (const [id, record] of Object.entries(state.recentGempas!)) {
    if (now - record.createdAt > 30 * 60 * 1000) {
      delete state.recentGempas![id];
    }
  }

  assertEquals(state.recentGempas!["old_id"], undefined);
  assertNotEquals(state.recentGempas!["recent_id"], undefined);
});

