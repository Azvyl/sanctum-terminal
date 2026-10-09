import {
  get,
  off,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  ref,
  serverTimestamp,
  type Unsubscribe,
  update,
} from "firebase/database";
import { ConfigManager, type ServiceName } from "./config.ts";
import { DB_PATHS, FirebaseManager } from "./firebase.ts";
import { Log } from "./logger.ts";
import { DiscordBotService } from "./bot/index.ts";
import { WidgetSchedulerEngine } from "./widgets/scheduler.ts";
import { StreamMinecraftBridge } from "./stream/bridge.ts";
import { StreamDiscordIntegrationManager } from "./stream/discord_integration.ts";

export type ManagedService = ServiceName;

export interface ServiceElectionState {
  current_leader: string | null;
  claimed_at?: number;
  last_heartbeat?: number;
  released_by?: string;
}

interface ServiceRunner {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  requiresDynamicListeners: boolean;
}

const MANAGED_SERVICES: ManagedService[] = [
  "discord_bot",
  "discord_widgets",
  "stream_bridge",
];

const SERVICE_RUNNERS: Record<ManagedService, ServiceRunner> = {
  discord_bot: {
    start: async () => {
      await DiscordBotService.start();
    },
    stop: async () => {
      await DiscordBotService.stop();
    },
    requiresDynamicListeners: true,
  },
  discord_widgets: {
    start: async () => {
      await WidgetSchedulerEngine.start();
    },
    stop: async () => {
      await WidgetSchedulerEngine.stop();
    },
    requiresDynamicListeners: true,
  },
  stream_bridge: {
    start: async () => {
      await StreamDiscordIntegrationManager.initialize();
      await StreamMinecraftBridge.start();
    },
    stop: async () => {
      await StreamMinecraftBridge.stop();
    },
    requiresDynamicListeners: false,
  },
};

export class ServiceElectionCoordinator {
  private static TAG = "ElectionCoordinator";
  private static isStarted = false;
  private static isEvaluating = false;
  private static needsReevaluation = false;
  private static evaluationIntervalId: ReturnType<typeof setInterval> | null = null;

  private static nodesUnsubscribers: Unsubscribe[] = [];
  private static electionsUnsubscribers: Unsubscribe[] = [];

  private static latestNodes = new Map<string, Record<string, unknown>>();
  private static latestElections = new Map<string, ServiceElectionState>();

  private static activeLocalServices = new Set<ManagedService>();
  private static pendingDebounceTimers = new Map<ManagedService, ReturnType<typeof setTimeout>>();

  private static readonly HEARTBEAT_STALE_THRESHOLD_MS = 60000;
  private static readonly TAKEOVER_DEBOUNCE_MS = 10000;

  static async start(): Promise<void> {
    if (this.isStarted) {
      Log.warn(this.TAG, "ServiceElectionCoordinator is already running.");
      return;
    }
    this.isStarted = true;
    Log.info(
      this.TAG,
      `Starting ServiceElectionCoordinator for node [${ConfigManager.NODE_ID}]. Enabled services: [${ConfigManager.ENABLED_SERVICES.join(", ") || "None (Telemetry Only)"
      }]`,
    );

    const nodesRef = ref(FirebaseManager.db, DB_PATHS.NODES);
    const electionsRef = ref(FirebaseManager.db, DB_PATHS.SERVICE_ELECTION);

    Log.info(this.TAG, "Fetching initial election and nodes state from Firebase RTDB...");
    try {
      const [nodesSnap, electionsSnap] = await Promise.all([
        get(nodesRef),
        get(electionsRef),
      ]);

      if (!this.isStarted) return;

      this.latestNodes.clear();
      const nodesData = nodesSnap.val();
      if (nodesData && typeof nodesData === "object") {
        for (const [nodeId, nData] of Object.entries(nodesData)) {
          if (nData && typeof nData === "object") {
            this.latestNodes.set(nodeId, nData as Record<string, unknown>);
          }
        }
      }

      this.latestElections.clear();
      const electionsData = electionsSnap.val();
      if (electionsData && typeof electionsData === "object") {
        for (const [svc, sData] of Object.entries(electionsData)) {
          if (sData && typeof sData === "object") {
            this.latestElections.set(svc, sData as ServiceElectionState);
          }
        }
      }

      Log.info(
        this.TAG,
        `Initial state loaded: ${this.latestNodes.size} nodes, ${this.latestElections.size} election locks.`,
      );
    } catch (err) {
      Log.error(this.TAG, "Failed fetching initial election/nodes state:", err);
    }

    if (!this.isStarted) return;

    await this.evaluateAll();

    if (!this.isStarted) return;

    this.setupDatabaseListeners(nodesRef, electionsRef);

    this.evaluationIntervalId = setInterval(async () => {
      await this.evaluateAll();
    }, 5000);
  }

  private static setupDatabaseListeners(
    nodesRef: ReturnType<typeof ref>,
    electionsRef: ReturnType<typeof ref>,
  ): void {
    const nodesAdded = onChildAdded(nodesRef, async (snapshot) => {
      const nodeId = snapshot.key;
      const nData = snapshot.val();
      if (!nodeId || !nData || typeof nData !== "object") return;

      const prev = this.latestNodes.get(nodeId);
      const next = nData as Record<string, unknown>;
      this.latestNodes.set(nodeId, next);

      if (!prev) {
        Log.debug(this.TAG, `New node detected: [${nodeId}]`);
        await this.evaluateAll();
      } else {
        const now = FirebaseManager.getCalibratedTime();
        if (this.hasNodeHealthOrStateChanged(prev, next, now)) {
          Log.debug(this.TAG, `Node state changed during sync for [${nodeId}], evaluating.`);
          await this.evaluateAll();
        }
      }
    });

    const nodesChanged = onChildChanged(nodesRef, async (snapshot) => {
      const nodeId = snapshot.key;
      const nData = snapshot.val();
      if (!nodeId || !nData || typeof nData !== "object") return;

      const prev = this.latestNodes.get(nodeId);
      const next = nData as Record<string, unknown>;
      this.latestNodes.set(nodeId, next);

      const now = FirebaseManager.getCalibratedTime();
      if (this.hasNodeHealthOrStateChanged(prev, next, now)) {
        Log.debug(this.TAG, `Node state/health changed for [${nodeId}], triggering evaluation.`);
        await this.evaluateAll();
      }
    });

    const nodesRemoved = onChildRemoved(nodesRef, async (snapshot) => {
      const nodeId = snapshot.key;
      if (!nodeId) return;
      Log.warn(this.TAG, `Node record removed from Firebase: [${nodeId}]`);
      this.latestNodes.delete(nodeId);
      await this.evaluateAll();
    });

    this.nodesUnsubscribers.push(nodesAdded, nodesChanged, nodesRemoved);

    const electionsAdded = onChildAdded(electionsRef, async (snapshot) => {
      const svc = snapshot.key;
      const sData = snapshot.val();
      if (!svc || !sData || typeof sData !== "object") return;

      const prev = this.latestElections.get(svc);
      const next = sData as ServiceElectionState;
      this.latestElections.set(svc, next);

      if (!prev) {
        Log.debug(this.TAG, `New service election lock detected: [${svc}]`);
        await this.evaluateAll();
      } else if (prev.current_leader !== next.current_leader || prev.released_by !== next.released_by) {
        Log.info(
          this.TAG,
          `Service election change during sync for [${svc}]: leader [${prev.current_leader ?? "none"}] -> [${next.current_leader ?? "none"}]`,
        );
        await this.evaluateAll();
      }
    });

    const electionsChanged = onChildChanged(electionsRef, async (snapshot) => {
      const svc = snapshot.key;
      const sData = snapshot.val();
      if (!svc || !sData || typeof sData !== "object") return;

      const prev = this.latestElections.get(svc);
      const next = sData as ServiceElectionState;
      this.latestElections.set(svc, next);

      const leaderChanged = prev?.current_leader !== next.current_leader;
      const releaseChanged = prev?.released_by !== next.released_by;

      if (leaderChanged || releaseChanged) {
        Log.info(
          this.TAG,
          `Service election change for [${svc}]: leader [${prev?.current_leader ?? "none"}] -> [${next.current_leader ?? "none"}]`,
        );
        await this.evaluateAll();
      }
    });

    const electionsRemoved = onChildRemoved(electionsRef, async (snapshot) => {
      const svc = snapshot.key;
      if (!svc) return;
      Log.warn(this.TAG, `Service election record removed: [${svc}]`);
      this.latestElections.delete(svc);
      await this.evaluateAll();
    });

    this.electionsUnsubscribers.push(electionsAdded, electionsChanged, electionsRemoved);
  }

  private static hasNodeHealthOrStateChanged(
    prev: Record<string, unknown> | undefined,
    next: Record<string, unknown>,
    now: number,
  ): boolean {
    if (!prev) return true;

    if (prev.is_active !== next.is_active) return true;

    const prevLastSeen = typeof prev.last_seen === "number" ? prev.last_seen : 0;
    const nextLastSeen = typeof next.last_seen === "number" ? next.last_seen : 0;
    const prevHealthy = prev.is_active === true && (now - prevLastSeen <= this.HEARTBEAT_STALE_THRESHOLD_MS);
    const nextHealthy = next.is_active === true && (now - nextLastSeen <= this.HEARTBEAT_STALE_THRESHOLD_MS);
    if (prevHealthy !== nextHealthy) return true;

    const prevServices = Array.isArray(prev.enabled_services) ? prev.enabled_services : [];
    const nextServices = Array.isArray(next.enabled_services) ? next.enabled_services : [];
    if (
      prevServices.length !== nextServices.length ||
      prevServices.some((s, i) => s !== nextServices[i])
    ) {
      return true;
    }

    return false;
  }

  static isServiceRunning(service: ManagedService): boolean {
    return this.activeLocalServices.has(service);
  }

  static getActiveServices(): ManagedService[] {
    return Array.from(this.activeLocalServices);
  }

  static getLeader(service: ManagedService): string | null {
    return this.latestElections.get(service)?.current_leader || null;
  }

  private static isNodeHealthy(nodeId: string, now: number): boolean {
    const data = this.latestNodes.get(nodeId);
    if (!data) return false;
    if (data.is_active !== true) return false;
    const lastSeen = typeof data.last_seen === "number" ? data.last_seen : 0;
    if (now - lastSeen > this.HEARTBEAT_STALE_THRESHOLD_MS) {
      return false;
    }
    return true;
  }

  private static async evaluateAll(): Promise<void> {
    if (!this.isStarted) return;
    if (this.isEvaluating) {
      this.needsReevaluation = true;
      return;
    }
    this.isEvaluating = true;

    try {
      do {
        this.needsReevaluation = false;
        for (const service of MANAGED_SERVICES) {
          if (!this.isStarted) break;
          await this.evaluateService(service);
        }
      } while (this.needsReevaluation && this.isStarted);

      const anyNeedsListeners = Array.from(this.activeLocalServices).some(
        (s) => SERVICE_RUNNERS[s]?.requiresDynamicListeners,
      );
      if (!anyNeedsListeners && FirebaseManager.isDynamicSyncActive) {
        Log.info(this.TAG, "No running local services require dynamic RTDB listeners. Detaching...");
        FirebaseManager.detachDynamicListeners();
      }
    } catch (err) {
      Log.error(this.TAG, "Error during election evaluation:", err);
    } finally {
      this.isEvaluating = false;
    }
  }

  private static async evaluateService(service: ManagedService): Promise<void> {
    const isCapable = ConfigManager.ENABLED_SERVICES.includes(service);
    const priorityList = ConfigManager.SERVICE_PRIORITIES[service] || [];
    const myNodeId = ConfigManager.NODE_ID;
    const myRank = priorityList.indexOf(myNodeId);

    if (!isCapable || myRank === -1) {
      const pendingTimer = this.pendingDebounceTimers.get(service);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.pendingDebounceTimers.delete(service);
      }
      if (this.activeLocalServices.has(service)) {
        Log.warn(
          this.TAG,
          `Service [${service}] is running locally but node is no longer capable/prioritized. Stopping...`,
        );
        await this.stopLocalService(service);
      }
      return;
    }

    const now = FirebaseManager.getCalibratedTime();
    const higherNodes = priorityList.slice(0, myRank);
    const activeHigherNode = myRank > 0
      ? higherNodes.find((hId) => this.isNodeHealthy(hId, now))
      : undefined;

    if (myRank > 0 && activeHigherNode) {
      const pendingTimer = this.pendingDebounceTimers.get(service);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.pendingDebounceTimers.delete(service);
        Log.info(
          this.TAG,
          `Cancelled pending takeover for [${service}]: Higher-priority node [${activeHigherNode}] is active.`,
        );
      }

      if (this.activeLocalServices.has(service)) {
        Log.warn(
          this.TAG,
          `Higher-priority node [${activeHigherNode}] is ONLINE for [${service}]. Relinquishing service leadership...`,
        );
        await this.stopLocalService(service);

        const election = this.latestElections.get(service);
        if (election?.current_leader === myNodeId) {
          await this.releaseLock(service);
        }
      }
      return;
    }

    const election = this.latestElections.get(service);
    const currentLeader = election?.current_leader;

    if (currentLeader === myNodeId) {
      if (!this.activeLocalServices.has(service)) {
        await this.startLocalService(service);
      }
      await this.refreshLockHeartbeat(service);
      return;
    }

    if (currentLeader && currentLeader !== myNodeId) {
      const leaderData = this.latestNodes.get(currentLeader);
      const leaderActive = this.isNodeHealthy(currentLeader, now);

      const leaderRank = priorityList.indexOf(currentLeader);
      const isLeaderLowerPriority = leaderRank > myRank || leaderRank === -1;

      if (!leaderActive) {
        const wasExplicitlyOffline = leaderData && leaderData.is_active === false;
        if (wasExplicitlyOffline) {
          Log.info(
            this.TAG,
            `Former leader [${currentLeader}] of [${service}] explicitly went offline. Claiming leadership immediately...`,
          );
          await this.claimLeadership(service);
        } else {
          this.scheduleTakeoverDebounce(service, currentLeader);
        }
      } else if (isLeaderLowerPriority) {
        Log.info(
          this.TAG,
          `This node [${myNodeId}] has higher priority than current leader [${currentLeader}] for [${service}]. Initiating takeover...`,
        );
        await this.claimLeadership(service);
      } else {
        if (this.activeLocalServices.has(service)) {
          Log.warn(
            this.TAG,
            `Node [${currentLeader}] is active leader for [${service}]. Stopping local duplicate service...`,
          );
          await this.stopLocalService(service);
        }
      }
      return;
    }

    if (!currentLeader) {
      if (myRank > 0 && activeHigherNode) {
        Log.warn(
          this.TAG,
          `Lock for [${service}] is unclaimed, but higher-priority node [${activeHigherNode}] is active. Deferring claim.`,
        );
        return;
      }

      Log.info(
        this.TAG,
        `Lock for [${service}] is unclaimed and no higher priority node is active. Claiming leadership...`,
      );
      await this.claimLeadership(service);
    }
  }

  private static scheduleTakeoverDebounce(
    service: ManagedService,
    deadLeader: string,
  ): void {
    if (this.pendingDebounceTimers.has(service)) return;

    Log.warn(
      this.TAG,
      `Leader [${deadLeader}] for [${service}] silent heartbeat detected. Starting ${this.TAKEOVER_DEBOUNCE_MS / 1000
      }s anti-flapping debounce before takeover...`,
    );

    const timer = setTimeout(async () => {
      this.pendingDebounceTimers.delete(service);
      const now = FirebaseManager.getCalibratedTime();
      const stillHealthy = this.isNodeHealthy(deadLeader, now);
      if (stillHealthy) {
        Log.info(
          this.TAG,
          `Takeover for [${service}] aborted: Leader [${deadLeader}] restored heartbeat before debounce expired.`,
        );
        return;
      }

      const priorityList = ConfigManager.SERVICE_PRIORITIES[service] || [];
      const myRank = priorityList.indexOf(ConfigManager.NODE_ID);
      if (myRank > 0) {
        const higherNodes = priorityList.slice(0, myRank);
        const activeHigherNode = higherNodes.find((hId) => this.isNodeHealthy(hId, now));
        if (activeHigherNode) {
          Log.info(
            this.TAG,
            `Takeover for [${service}] aborted: Higher-priority node [${activeHigherNode}] is active.`,
          );
          return;
        }
      }

      Log.warn(
        this.TAG,
        `Takeover confirmed for [${service}]: Leader [${deadLeader}] remained silent. Claiming lock...`,
      );
      await this.claimLeadership(service);
    }, this.TAKEOVER_DEBOUNCE_MS);

    this.pendingDebounceTimers.set(service, timer);
  }

  private static async claimLeadership(service: ManagedService): Promise<void> {
    const priorityList = ConfigManager.SERVICE_PRIORITIES[service] || [];
    const myNodeId = ConfigManager.NODE_ID;
    const myRank = priorityList.indexOf(myNodeId);
    const now = FirebaseManager.getCalibratedTime();

    if (myRank > 0) {
      const higherNodes = priorityList.slice(0, myRank);
      const activeHigherNode = higherNodes.find((hId) => this.isNodeHealthy(hId, now));
      if (activeHigherNode) {
        Log.warn(
          this.TAG,
          `Blocked leadership claim for [${service}]: Higher-priority node [${activeHigherNode}] is currently active.`,
        );
        return;
      }
    }

    const serviceRef = ref(FirebaseManager.db, `${DB_PATHS.SERVICE_ELECTION}/${service}`);

    try {
      Log.info(this.TAG, `Writing service election lock for [${service}] -> Leader: [${myNodeId}]`);
      await update(serviceRef, {
        current_leader: myNodeId,
        claimed_at: serverTimestamp(),
        last_heartbeat: serverTimestamp(),
        released_by: null,
      });

      this.latestElections.set(service, {
        current_leader: myNodeId,
        claimed_at: Date.now(),
        last_heartbeat: Date.now(),
      });

      await this.startLocalService(service);
      Log.success(this.TAG, `Leadership claimed and service [${service}] running on [${myNodeId}].`);
    } catch (err) {
      Log.error(this.TAG, `Failed claiming leadership for [${service}]:`, err);
    }
  }

  private static async refreshLockHeartbeat(service: ManagedService): Promise<void> {
    const serviceRef = ref(FirebaseManager.db, `${DB_PATHS.SERVICE_ELECTION}/${service}`);
    try {
      await update(serviceRef, {
        current_leader: ConfigManager.NODE_ID,
        last_heartbeat: serverTimestamp(),
      });
    } catch (err) {
      Log.debug(this.TAG, `Failed refreshing election lock heartbeat for [${service}]:`, err);
    }
  }

  private static async releaseLock(service: ManagedService): Promise<void> {
    const serviceRef = ref(FirebaseManager.db, `${DB_PATHS.SERVICE_ELECTION}/${service}`);
    try {
      Log.info(this.TAG, `Releasing service election lock for [${service}]...`);
      await update(serviceRef, {
        current_leader: null,
        released_by: ConfigManager.NODE_ID,
        last_heartbeat: serverTimestamp(),
      });
      this.latestElections.delete(service);
    } catch (err) {
      Log.error(this.TAG, `Failed releasing lock for [${service}]:`, err);
    }
  }

  private static async startLocalService(service: ManagedService): Promise<void> {
    if (this.activeLocalServices.has(service)) return;

    const runner = SERVICE_RUNNERS[service];
    if (!runner) return;

    try {
      if (runner.requiresDynamicListeners && !FirebaseManager.isDynamicSyncActive) {
        Log.info(this.TAG, `Service [${service}] requires dynamic RTDB listeners. Attaching...`);
        await FirebaseManager.attachDynamicListeners();
      }

      Log.info(this.TAG, `Starting local service [${service}]...`);
      await runner.start();
      this.activeLocalServices.add(service);
      Log.success(this.TAG, `Service [${service}] is now active locally.`);
    } catch (err) {
      Log.error(this.TAG, `Failed starting local service [${service}]:`, err);
    }
  }

  private static async stopLocalService(service: ManagedService): Promise<void> {
    if (!this.activeLocalServices.has(service)) return;

    const runner = SERVICE_RUNNERS[service];
    if (!runner) return;

    try {
      Log.warn(this.TAG, `Stopping local service [${service}]...`);
      await runner.stop();
      this.activeLocalServices.delete(service);
      Log.success(this.TAG, `Local service [${service}] stopped.`);

      const anyNeedsListeners = Array.from(this.activeLocalServices).some(
        (s) => SERVICE_RUNNERS[s]?.requiresDynamicListeners,
      );

      if (!anyNeedsListeners && FirebaseManager.isDynamicSyncActive) {
        Log.info(this.TAG, "No running local services require dynamic RTDB listeners. Detaching...");
        FirebaseManager.detachDynamicListeners();
      }
    } catch (err) {
      Log.error(this.TAG, `Failed stopping local service [${service}]:`, err);
    }
  }

  static async stop(): Promise<void> {
    if (!this.isStarted) return;
    this.isStarted = false;
    Log.warn(this.TAG, "Stopping ServiceElectionCoordinator and all local services...");

    if (this.evaluationIntervalId !== null) {
      clearInterval(this.evaluationIntervalId);
      this.evaluationIntervalId = null;
    }
    for (const [_, timer] of this.pendingDebounceTimers) {
      clearTimeout(timer);
    }
    this.pendingDebounceTimers.clear();

    for (const unsub of this.nodesUnsubscribers) {
      try {
        unsub();
      } catch (_) {
        // Ignore
      }
    }
    this.nodesUnsubscribers = [];

    for (const unsub of this.electionsUnsubscribers) {
      try {
        unsub();
      } catch (_) {
        // Ignore
      }
    }
    this.electionsUnsubscribers = [];

    try {
      off(ref(FirebaseManager.db, DB_PATHS.NODES));
      off(ref(FirebaseManager.db, DB_PATHS.SERVICE_ELECTION));
    } catch (_) {
      // Ignore
    }

    const running = Array.from(this.activeLocalServices);
    for (const svc of running) {
      await this.stopLocalService(svc);
      const election = this.latestElections.get(svc);
      if (election?.current_leader === ConfigManager.NODE_ID) {
        await this.releaseLock(svc);
      }
    }

    this.latestNodes.clear();
    this.latestElections.clear();

    if (FirebaseManager.isDynamicSyncActive) {
      FirebaseManager.detachDynamicListeners();
    }

    Log.success(this.TAG, "ServiceElectionCoordinator stopped completely.");
  }
}
