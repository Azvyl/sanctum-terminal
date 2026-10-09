import { initializeApp } from "firebase/app";
import {
  type Database,
  get,
  getDatabase,
  off,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onDisconnect,
  onValue,
  ref,
  serverTimestamp,
  set,
  type Unsubscribe,
  update,
} from "firebase/database";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { ConfigManager } from "./config.ts";
import { Log } from "./logger.ts";
import type { TelemetryData } from "./telemetry.ts";

export const DB_PATHS = {
  NODES: "schale/nodes",
  TELEMETRY: "schale/telemetry",
  SERVICE_ELECTION: "schale/service_election",
  STATE_BOT_TRACKER: "schale/states/bot_tracker",
  STATE_WEATHER_TRACKER: "schale/states/weather_tracker",
  STATE_AI_PHASE: "schale/states/ai_phase",
  STATE_STREAM_INTEGRATION: "schale/states/stream_integration",
  RATE_LIMITS: "schale/rate_limits",
  WIDGET_DATA: "schale/widget_data",
};

export class FirebaseManager {
  private static TAG = "FirebaseManager";
  public static db: Database;
  public static serverTimeOffset = 0;
  public static remoteRateLimits = new Map<string, number>();
  public static cachedWidgetData = new Map<string, Record<string, unknown>>();
  public static cachedTelemetry = new Map<string, TelemetryData>();
  public static cachedNodes = new Map<string, Record<string, unknown>>();
  public static lastSyncedAiPhase: string | null = null;
  private static dynamicUnsubscribers: Unsubscribe[] = [];
  public static isDynamicSyncActive = false;
  private static heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
  private static connectedUnsubscribe: Unsubscribe | null = null;

  static async initialize() {
    Log.info(this.TAG, `Connecting to Firebase RTDB for node: [${ConfigManager.NODE_ID.toUpperCase()}]...`);
    const dbUrl = Deno.env.get("FIREBASE_DB_URL");
    if (!dbUrl) throw new Error("Missing FIREBASE_DB_URL environment variable!");

    const app = initializeApp({
      databaseURL: dbUrl,
      apiKey: Deno.env.get("FIREBASE_API_KEY") || undefined,
      authDomain: Deno.env.get("FIREBASE_AUTH_DOMAIN") || undefined,
      projectId: Deno.env.get("FIREBASE_PROJECT_ID") || undefined,
      storageBucket: Deno.env.get("FIREBASE_STORAGE_BUCKET") || undefined,
      messagingSenderId: Deno.env.get("FIREBASE_MESSAGING_SENDER_ID") || undefined,
      appId: Deno.env.get("FIREBASE_APP_ID") || undefined,
    });

    this.db = getDatabase(app);

    const authEmail = Deno.env.get("FIREBASE_AUTH_EMAIL");
    const authPassword = Deno.env.get("FIREBASE_AUTH_PASSWORD");

    if (authEmail && authPassword) {
      try {
        await signInWithEmailAndPassword(getAuth(app), authEmail, authPassword);
        Log.success(this.TAG, `Firebase Authenticated as: [${authEmail}].`);
      } catch (err) {
        Log.error(this.TAG, "Firebase Authentication failed:", err);
        throw err;
      }
    } else {
      Log.warn(
        this.TAG,
        "FIREBASE_AUTH_EMAIL and/or FIREBASE_AUTH_PASSWORD not configured. Continuing without session.",
      );
    }

    onValue(ref(this.db, ".info/serverTimeOffset"), (snap) => {
      const val = snap.val() || 0;
      Log.debug(this.TAG, `[DB RECV] onValue -> Path: ".info/serverTimeOffset" | Server Offset: ${val}ms`);
      this.serverTimeOffset = val;
    });

    this.setupNodePresence();
  }

  static getCalibratedTime(): number {
    return Date.now() + this.serverTimeOffset;
  }

  private static setupNodePresence() {
    const nodePath = `${DB_PATHS.NODES}/${ConfigManager.NODE_ID}`;
    const nodeRef = ref(this.db, nodePath);
    const connectedRef = ref(this.db, ".info/connected");

    const disconnectPayload: Record<string, unknown> = {
      is_active: false,
      last_seen: serverTimestamp(),
    };

    this.connectedUnsubscribe = onValue(connectedRef, async (snap) => {
      const isConnected = snap.val() === true;
      if (isConnected) {
        Log.info(this.TAG, `Native Firebase connection established (.info/connected). Registering presence for [${ConfigManager.NODE_ID}]...`);

        try {
          await onDisconnect(nodeRef).update(disconnectPayload);

          const initialPayload: Record<string, unknown> = {
            is_active: true,
            node_id: ConfigManager.NODE_ID,
            device_name: ConfigManager.NODE_NAME,
            role: ConfigManager.NODE_ID,
            os: Deno.build.os,
            enabled_services: ConfigManager.ENABLED_SERVICES,
            connected_at: serverTimestamp(),
            last_seen: serverTimestamp(),
          };

          Log.debug(this.TAG, `[DB SEND] Registering active presence (set) -> Path: "${nodePath}"`, initialPayload);
          await set(nodeRef, initialPayload);
        } catch (err) {
          Log.error(this.TAG, "Failed setting active presence payload:", err);
        }
      } else {
        Log.warn(this.TAG, "Firebase connection status: Disconnected (.info/connected = false)");
      }
    });

    const heartbeatIntervalMs = 15000;

    if (this.heartbeatIntervalId !== null) {
      clearInterval(this.heartbeatIntervalId);
    }

    this.heartbeatIntervalId = setInterval(async () => {
      try {
        const heartbeatPayload = {
          is_active: true,
          last_seen: serverTimestamp(),
        };
        Log.debug(this.TAG, `[DB SEND] Heartbeat ping (update) -> Path: "${nodePath}"`);
        await update(nodeRef, heartbeatPayload);
      } catch (err) {
        Log.error(this.TAG, "Failed sending node heartbeat ping:", err);
      }
    }, heartbeatIntervalMs);
  }

  static stopNodePresence() {
    if (this.heartbeatIntervalId !== null) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }
    if (this.connectedUnsubscribe !== null) {
      try {
        this.connectedUnsubscribe();
      } catch (_) {
        // Ignore
      }
      this.connectedUnsubscribe = null;
    }
  }

  static async attachDynamicListeners(): Promise<void> {
    if (this.isDynamicSyncActive) {
      Log.debug(this.TAG, "Dynamic sync listeners are already active. Skipping attach.");
      return;
    }
    this.isDynamicSyncActive = true;
    Log.info(
      this.TAG,
      `Attaching dynamic Firebase data sync listeners (widget_data, rate_limits, telemetry, nodes, ai_phase) for [${ConfigManager.NODE_ID.toUpperCase()}]...`,
    );
    await this.setupWidgetDataSync();
    await this.setupGlobalRateLimitsSync();
    await this.setupTelemetryAndNodesSync();
    Log.success(this.TAG, "Dynamic Firebase data sync listeners active.");
  }

  static detachDynamicListeners(): void {
    if (!this.isDynamicSyncActive) {
      Log.debug(this.TAG, "Dynamic sync listeners are not active. Skipping detach.");
      return;
    }
    Log.info(
      this.TAG,
      `Detaching dynamic Firebase data sync listeners for [${ConfigManager.NODE_ID.toUpperCase()}]...`,
    );

    for (const unsub of this.dynamicUnsubscribers) {
      try {
        unsub();
      } catch (err) {
        Log.error(this.TAG, "Error invoking unsubscribe callback:", err);
      }
    }
    this.dynamicUnsubscribers = [];

    try {
      off(ref(this.db, DB_PATHS.WIDGET_DATA));
      off(ref(this.db, DB_PATHS.STATE_AI_PHASE));
      off(ref(this.db, DB_PATHS.RATE_LIMITS));
      off(ref(this.db, DB_PATHS.TELEMETRY));
      off(ref(this.db, DB_PATHS.NODES));
    } catch (err) {
      Log.error(this.TAG, "Error executing off() on database refs:", err);
    }

    this.cachedWidgetData.clear();
    this.remoteRateLimits.clear();
    this.cachedTelemetry.clear();
    this.cachedNodes.clear();
    this.lastSyncedAiPhase = null;
    this.isDynamicSyncActive = false;

    Log.success(this.TAG, "All dynamic Firebase sync listeners detached and cache cleared.");
  }

  public static async setupTelemetryAndNodesSync() {
    const telemetryRef = ref(this.db, DB_PATHS.TELEMETRY);
    const nodesRef = ref(this.db, DB_PATHS.NODES);

    try {
      Log.debug(this.TAG, `[DB SEND/GET REQUEST] Fetching initial Telemetry -> Path: "${DB_PATHS.TELEMETRY}"`);
      const snap = await get(telemetryRef);
      const val = snap.val();
      if (val && typeof val === "object") {
        for (const [key, tData] of Object.entries(val)) {
          if (tData && typeof tData === "object") {
            this.cachedTelemetry.set(key, tData as TelemetryData);
          }
        }
      }
      Log.info(this.TAG, `Initial Telemetry cache populated (${this.cachedTelemetry.size} items).`);
    } catch (err) {
      Log.error(this.TAG, "Failed initial fetch for telemetry:", err);
    }

    try {
      Log.debug(this.TAG, `[DB SEND/GET REQUEST] Fetching initial Nodes -> Path: "${DB_PATHS.NODES}"`);
      const snap = await get(nodesRef);
      const val = snap.val();
      if (val && typeof val === "object") {
        for (const [key, nData] of Object.entries(val)) {
          if (nData && typeof nData === "object") {
            this.cachedNodes.set(key, nData as Record<string, unknown>);
          }
        }
      }
      Log.info(this.TAG, `Initial Nodes cache populated (${this.cachedNodes.size} items).`);
    } catch (err) {
      Log.error(this.TAG, "Failed initial fetch for nodes:", err);
    }

    const unsubTelemetryAdded = onChildAdded(telemetryRef, (snap) => {
      const key = snap.key;
      const tData = snap.val();
      Log.debug(this.TAG, `[DB RECV] onChildAdded -> Path: "${DB_PATHS.TELEMETRY}/${key}"`, tData);
      if (key && tData && typeof tData === "object") {
        this.cachedTelemetry.set(key, tData as TelemetryData);
      }
    });

    const unsubTelemetryChanged = onChildChanged(telemetryRef, (snap) => {
      const key = snap.key;
      const tData = snap.val();
      Log.debug(this.TAG, `[DB RECV] onChildChanged -> Path: "${DB_PATHS.TELEMETRY}/${key}"`, tData);
      if (key && tData && typeof tData === "object") {
        this.cachedTelemetry.set(key, tData as TelemetryData);
      }
    });

    const unsubTelemetryRemoved = onChildRemoved(telemetryRef, (snap) => {
      const key = snap.key;
      Log.debug(this.TAG, `[DB RECV] onChildRemoved -> Path: "${DB_PATHS.TELEMETRY}/${key}"`);
      if (key) {
        this.cachedTelemetry.delete(key);
      }
    });

    const unsubNodesAdded = onChildAdded(nodesRef, (snap) => {
      const key = snap.key;
      const nData = snap.val();
      Log.debug(this.TAG, `[DB RECV] onChildAdded -> Path: "${DB_PATHS.NODES}/${key}"`, nData);
      if (key && nData && typeof nData === "object") {
        this.cachedNodes.set(key, nData as Record<string, unknown>);
      }
    });

    const unsubNodesChanged = onChildChanged(nodesRef, (snap) => {
      const key = snap.key;
      const nData = snap.val();
      Log.debug(this.TAG, `[DB RECV] onChildChanged -> Path: "${DB_PATHS.NODES}/${key}"`, nData);
      if (key && nData && typeof nData === "object") {
        this.cachedNodes.set(key, nData as Record<string, unknown>);
      }
    });

    const unsubNodesRemoved = onChildRemoved(nodesRef, (snap) => {
      const key = snap.key;
      Log.debug(this.TAG, `[DB RECV] onChildRemoved -> Path: "${DB_PATHS.NODES}/${key}"`);
      if (key) {
        this.cachedNodes.delete(key);
      }
    });

    this.dynamicUnsubscribers.push(
      unsubTelemetryAdded,
      unsubTelemetryChanged,
      unsubTelemetryRemoved,
      unsubNodesAdded,
      unsubNodesChanged,
      unsubNodesRemoved,
    );
  }

  public static async setupWidgetDataSync() {
    const widgetDataRef = ref(this.db, DB_PATHS.WIDGET_DATA);
    try {
      Log.debug(this.TAG, `[DB SEND/GET REQUEST] Fetching initial Widget Data -> Path: "${DB_PATHS.WIDGET_DATA}"`);
      const snapshot = await get(widgetDataRef);
      const data = snapshot.val();
      Log.debug(this.TAG, `[DB RECV] get -> Path: "${DB_PATHS.WIDGET_DATA}"`, data ? `Found ${Object.keys(data).length} keys` : "Null");
      if (data && typeof data === "object") {
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object") {
            this.cachedWidgetData.set(key, value as Record<string, unknown>);
          }
        }
      }
      Log.info(this.TAG, `Initial Widget Data cache populated (${this.cachedWidgetData.size} items).`);
    } catch (err) {
      Log.error(this.TAG, "Failed initial fetch for widget data:", err);
    }

    const unsubAdded = onChildAdded(widgetDataRef, (snapshot) => {
      const key = snapshot.key;
      const value = snapshot.val();
      Log.debug(this.TAG, `[DB RECV] onChildAdded -> Path: "${DB_PATHS.WIDGET_DATA}/${key}"`, value);
      if (key && value && typeof value === "object") {
        this.cachedWidgetData.set(key, value as Record<string, unknown>);
      }
    });

    const unsubChanged = onChildChanged(widgetDataRef, (snapshot) => {
      const key = snapshot.key;
      const value = snapshot.val();
      Log.debug(this.TAG, `[DB RECV] onChildChanged -> Path: "${DB_PATHS.WIDGET_DATA}/${key}"`, value);
      if (key && value && typeof value === "object") {
        this.cachedWidgetData.set(key, value as Record<string, unknown>);
      }
    });

    const unsubRemoved = onChildRemoved(widgetDataRef, (snapshot) => {
      const key = snapshot.key;
      Log.debug(this.TAG, `[DB RECV] onChildRemoved -> Path: "${DB_PATHS.WIDGET_DATA}/${key}"`);
      if (key) {
        this.cachedWidgetData.delete(key);
      }
    });

    const aiPhaseRef = ref(this.db, DB_PATHS.STATE_AI_PHASE);
    const unsubAiPhase = onValue(aiPhaseRef, (snapshot) => {
      const val = snapshot.val();
      Log.debug(this.TAG, `[DB RECV] onValue -> Path: "${DB_PATHS.STATE_AI_PHASE}"`, val);
      this.lastSyncedAiPhase = val;
    });

    this.dynamicUnsubscribers.push(unsubAdded, unsubChanged, unsubRemoved, unsubAiPhase);
  }

  public static async setupGlobalRateLimitsSync() {
    const rateLimitsRef = ref(this.db, DB_PATHS.RATE_LIMITS);
    try {
      Log.debug(this.TAG, `[DB SEND/GET REQUEST] Fetching initial Rate Limits -> Path: "${DB_PATHS.RATE_LIMITS}"`);
      const snapshot = await get(rateLimitsRef);
      const data = snapshot.val();
      Log.debug(this.TAG, `[DB RECV] get -> Path: "${DB_PATHS.RATE_LIMITS}"`, data);
      if (data && typeof data === "object") {
        for (const [appId, val] of Object.entries(data as Record<string, { reset_at?: number }>)) {
          const resetAt = val?.reset_at || 0;
          if (resetAt > this.getCalibratedTime()) {
            this.remoteRateLimits.set(appId, resetAt);
          }
        }
      }
    } catch (err) {
      Log.error(this.TAG, "Failed initial fetch for rate limits:", err);
    }

    const unsubAdded = onChildAdded(rateLimitsRef, (snapshot) => {
      const appId = snapshot.key;
      const data = snapshot.val();
      Log.debug(this.TAG, `[DB RECV] onChildAdded -> Path: "${DB_PATHS.RATE_LIMITS}/${appId}"`, data);
      if (appId && data) {
        const resetAt = data.reset_at || 0;
        if (resetAt > this.getCalibratedTime()) {
          this.remoteRateLimits.set(appId, resetAt);
        }
      }
    });

    const unsubChanged = onChildChanged(rateLimitsRef, (snapshot) => {
      const appId = snapshot.key;
      const data = snapshot.val();
      Log.debug(this.TAG, `[DB RECV] onChildChanged -> Path: "${DB_PATHS.RATE_LIMITS}/${appId}"`, data);
      if (appId && data) {
        const resetAt = data.reset_at || 0;
        if (resetAt > this.getCalibratedTime()) {
          this.remoteRateLimits.set(appId, resetAt);
        } else {
          this.remoteRateLimits.delete(appId);
        }
      }
    });

    const unsubRemoved = onChildRemoved(rateLimitsRef, (snapshot) => {
      const appId = snapshot.key;
      Log.debug(this.TAG, `[DB RECV] onChildRemoved -> Path: "${DB_PATHS.RATE_LIMITS}/${appId}"`);
      if (appId) {
        this.remoteRateLimits.delete(appId);
      }
    });

    this.dynamicUnsubscribers.push(unsubAdded, unsubChanged, unsubRemoved);
  }

  static async publishRateLimitLock(appId: string, widgetName: string, resetAfterSeconds: number) {
    const calibratedResetAt = this.getCalibratedTime() + (resetAfterSeconds * 1000);
    const path = `${DB_PATHS.RATE_LIMITS}/${appId}`;
    const payload = {
      app_id: appId,
      widget_name: widgetName,
      reset_at: calibratedResetAt,
      locked_by: ConfigManager.NODE_ID,
      updated_at: serverTimestamp(),
    };
    try {
      Log.debug(this.TAG, `[DB SEND] Publishing Rate Limit lock (set) -> Path: "${path}"`, payload);
      await set(ref(this.db, path), payload);
    } catch (err) {
      Log.error(this.TAG, "Failed publishing rate limit lock:", err);
    }
  }

  static async setLastAiPhase(phaseName: string) {
    this.lastSyncedAiPhase = phaseName;
    Log.debug(this.TAG, `[DB SEND] Publishing AI Phase update (set) -> Path: "${DB_PATHS.STATE_AI_PHASE}" | Value: "${phaseName}"`);
    await set(ref(this.db, DB_PATHS.STATE_AI_PHASE), phaseName);
  }

  static getCachedWidgetData(widgetKey: string): Record<string, unknown> | null {
    return this.cachedWidgetData.get(widgetKey) || null;
  }

  static getLatestTelemetry(role: string): TelemetryData | null {
    return this.cachedTelemetry.get(role) || null;
  }

  static getAllLatestTelemetry(): Map<string, TelemetryData> {
    return this.cachedTelemetry;
  }

  static getNodeMetadata(role: string): Record<string, unknown> | null {
    return this.cachedNodes.get(role) || null;
  }
}

