export const getArgVal = (key: string): string | null => {
  const arg = Deno.args.find((a) => a.startsWith(`--${key}=`));
  return arg ? arg.split("=")[1] : null;
};

const resolveNodeId = (): string => {
  const explicit = getArgVal("node-id") || getArgVal("role") || Deno.env.get("NODE_ID");
  if (explicit && explicit.trim()) {
    return explicit.trim().toLowerCase();
  }
  try {
    const hostname = Deno.hostname();
    if (hostname && hostname.trim()) {
      return hostname.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    }
  } catch {
    // Hostname introspection unavailable
  }
  return "node-" + Math.random().toString(36).substring(2, 8);
};

const resolvedNodeId = resolveNodeId();

const resolveEnabledServices = (): string[] => {
  const envVal = Deno.env.get("ENABLED_SERVICES");
  if (envVal !== undefined) {
    return envVal
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
};

export type ServiceName = "discord_bot" | "discord_widgets" | "stream_bridge";

export interface BotActivityConfig {
  name: string;
  type?: "Watching" | "Playing" | "Listening" | "Custom" | "Competing" | string;
  state?: string;
  url?: string;
  durationSeconds?: number;
}

const parseBotActivities = (): BotActivityConfig[] => {
  const envVal = Deno.env.get("DISCORD_BOT_ACTIVITIES");
  if (!envVal || !envVal.trim()) {
    return [
      { name: "Minecraft BDS", type: "Watching", durationSeconds: 30 },
      { name: "Sanctum Node", type: "Custom", state: "System Healthy", durationSeconds: 30 },
    ];
  }
  const trimmed = envVal.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => {
          if (typeof item === "string") {
            return { name: item, type: "Playing" };
          }
          return {
            name: String(item.name || "Sanctum Node"),
            type: item.type || "Playing",
            state: item.state,
            url: item.url,
            durationSeconds: typeof item.durationSeconds === "number" ? item.durationSeconds : undefined,
          };
        });
      }
    } catch {
      // Fall through to comma-separated parsing
    }
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, type: "Playing" }));
};

export const ConfigManager = {
  NODE_ID: resolvedNodeId,
  NODE_NAME: Deno.env.get("NODE_NAME") || getArgVal("node-name") || Deno.env.get("DEVICE_NAME") || resolvedNodeId,
  IS_DEBUG: Deno.args.includes("--debug") || Deno.env.get("DEBUG") === "true",
  ENABLED_SERVICES: resolveEnabledServices(),

  SERVICE_PRIORITIES: {
    discord_bot: (Deno.env.get("SERVICE_PRIORITY_DISCORD_BOT") || "vps,realme")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    discord_widgets: (Deno.env.get("SERVICE_PRIORITY_DISCORD_WIDGETS") || "vps,realme")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    stream_bridge: (Deno.env.get("SERVICE_PRIORITY_STREAM_BRIDGE") || "vps,asus")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  } as Record<ServiceName, string[]>,

  DISCORD_BOT_TOKEN: Deno.env.get("DISCORD_BOT_TOKEN") || "",
  DISCORD_BOT_APPLICATION_ID: Deno.env.get("DISCORD_BOT_APPLICATION_ID") || "",
  DISCORD_OWNER_USER_ID: Deno.env.get("DISCORD_OWNER_USER_ID") || "",

  DISCORD_BOT_ACTIVITIES: parseBotActivities(),
  DISCORD_BOT_ACTIVITY_INTERVAL_SECONDS: parseInt(
    Deno.env.get("DISCORD_BOT_ACTIVITY_INTERVAL_SECONDS") || "30",
    10,
  ),

  APP_LOCALE: ((Deno.env.get("APP_LOCALE") || "en").toLowerCase() === "id" ? "id" : "en") as "en" | "id",

  STATUS_UPDATE_INTERVAL_MS: 21 * 1000,
  ID_CARD_ROTATION_INTERVAL_MS: 3 * 60 * 1000,
  MINECRAFT_ROTATION_INTERVAL_MS: 3 * 60 * 1000,

  DEFAULT_APP_IDS: {
    STATUS: Deno.env.get("APP_ID_SHITTIM_CHEST_STATUS") || "",
    AI: Deno.env.get("APP_ID_SHITTIM_CHEST_AI") || "",
    SENSEI_CARD: Deno.env.get("APP_ID_SENSEI_ID_CARD") || "",
    MINECRAFT: Deno.env.get("APP_ID_MINECRAFT_BEDROCK") || "",
    GITHUB: Deno.env.get("APP_ID_GITHUB_STATS") || "",
  },

  STREAM_CONFIG: {
    port: parseInt(Deno.env.get("STREAM_PORT") || "8080", 10),
    authName: Deno.env.get("STREAM_AUTH_NAME") || "SanctumStream_Auth",
    botPrefix: Deno.env.get("STREAM_BOT_PREFIX") || "[SanctumBot]",
    whitelistDurationMinutes: 10,
    isCreativeWorld: true,
    streamer: {
      youtubeUsername: Deno.env.get("STREAMER_YOUTUBE_HANDLE") || "Azvylia Nekonova",
      xboxGamertag: Deno.env.get("STREAMER_XBOX_GAMERTAG") || "Azvylia",
      adminUsernames: (Deno.env.get("STREAMER_ADMIN_USERNAMES") || "Azvylia")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    friendLimitThreshold: 1900,
    xboxLive: { cacheDir: "./auth_cache" },
    feedback: {
      enableDiscordWebhook: Deno.env.get("ENABLE_DISCORD_WEBHOOK") === "true",
      discordWebhookUrl: Deno.env.get("DISCORD_WEBHOOK_URL") || "",
    },
  },

  GITHUB_USERNAME: Deno.env.get("GITHUB_USERNAME") || "Azvyl",
};

export const DISCORD_CHANNELS = {
  MINECRAFT_UPDATE: Deno.env.get("DISCORD_CHANNEL_MINECRAFT_UPDATE") || "1262771082499199037",
  BMKG_EARTHQUAKE: Deno.env.get("DISCORD_CHANNEL_BMKG_EARTHQUAKE") || "1263030931682234410",
  BMKG_WEATHER_NOTICE: Deno.env.get("DISCORD_CHANNEL_BMKG_WEATHER_NOTICE") || "1525671620776296468",
  CHAT_INTEGRATION: Deno.env.get("DISCORD_CHANNEL_CHAT_INTEGRATION") || "1541763903388647504",
};

export const DISCORD_ROLES = {
  BEDROCK_PING: Deno.env.get("DISCORD_ROLE_BEDROCK_PING") || "1525135708841312266",
  JAVA_PING: Deno.env.get("DISCORD_ROLE_JAVA_PING") || "1525143029655146630",
  GEMPA_PING: Deno.env.get("DISCORD_ROLE_GEMPA_PING") || "1525143967455383602",
};

export const UPDATE_TAGS = {
  BEDROCK_GAME_DROP: Deno.env.get("DISCORD_TAG_BEDROCK_GAME_DROP") || "1525359903248748685",
  BEDROCK_MINOR_UPDATE: Deno.env.get("DISCORD_TAG_BEDROCK_MINOR_UPDATE") || "1262773995154182184",
  BEDROCK_PREVIEW: Deno.env.get("DISCORD_TAG_BEDROCK_PREVIEW") || "1262774022970806344",
  BEDROCK_HOTFIX: Deno.env.get("DISCORD_TAG_BEDROCK_HOTFIX") || "1525185569771094086",
  JAVA_GAME_DROP: Deno.env.get("DISCORD_TAG_JAVA_GAME_DROP") || "1525316723345981503",
  JAVA_MINOR_HOTFIX: Deno.env.get("DISCORD_TAG_JAVA_MINOR_HOTFIX") || "1525366687300321310",
  JAVA_SNAPSHOT: Deno.env.get("DISCORD_TAG_JAVA_SNAPSHOT") || "1525316756707610695",
  JAVA_RELEASE_CANDIDATE: Deno.env.get("DISCORD_TAG_JAVA_RELEASE_CANDIDATE") || "1525348841199763649",
};

export const WEATHER_TAGS = {
  STATUS_AKTIF: Deno.env.get("DISCORD_TAG_STATUS_AKTIF") || "1526015380483608586",
  STATUS_PASIF: Deno.env.get("DISCORD_TAG_STATUS_PASIF") || "1526015651402223636",
  POTENSI_EKSTREM: Deno.env.get("DISCORD_TAG_POTENSI_EKSTREM") || "1526015677927002112",
  PERINGATAN_DINI: Deno.env.get("DISCORD_TAG_PERINGATAN_DINI") || "1526015789830770828",
  GELOMBANG_TINGGI: Deno.env.get("DISCORD_TAG_GELOMBANG_TINGGI") || "1526015846303006760",
};
