import { ConfigManager } from "../config.ts";
import { FirebaseManager } from "../firebase.ts";
import { Log } from "../logger.ts";
import { SystemTelemetry, TelemetryData } from "../telemetry.ts";

export interface WidgetContext {
  lastUpdateTime: number;
  currentDeviceRole: string;
}

export interface DiscordWidget {
  appId: string;
  name: string;
  shouldUpdate(context: WidgetContext): Promise<boolean>;
  getPayload(): Promise<Record<string, unknown>>;
  onSuccess(payload: Record<string, unknown>): Promise<void>;
}

export class RateLimitedHttpClient {
  private static TAG = "RateLimiter";
  private static localLocks = new Map<string, number>();

  static isLocked(appId: string): boolean {
    const currentCalibrated = FirebaseManager.getCalibratedTime();
    const localLockReset = this.localLocks.get(appId);
    if (localLockReset && Date.now() < localLockReset) {
      return true;
    } else if (localLockReset) {
      Log.success(this.TAG, `Local rate-limit lock expired for App ID: ${appId}. Releasing lock.`);
      this.localLocks.delete(appId);
    }
    const remoteLockReset = FirebaseManager.remoteRateLimits.get(appId);
    if (remoteLockReset && currentCalibrated < remoteLockReset) {
      return true;
    } else if (remoteLockReset) {
      Log.success(this.TAG, `Remote synchronized rate-limit lock expired for App ID: ${appId}.`);
      FirebaseManager.remoteRateLimits.delete(appId);
    }
    return false;
  }

  static getRemainingLockTime(appId: string): number {
    const currentCalibrated = FirebaseManager.getCalibratedTime();
    const localLockReset = this.localLocks.get(appId) || 0;
    const remoteLockReset = FirebaseManager.remoteRateLimits.get(appId) || 0;
    const localRemaining = Math.max(0, localLockReset - Date.now());
    const remoteRemaining = Math.max(0, remoteLockReset - currentCalibrated);
    return Math.max(localRemaining, remoteRemaining);
  }

  static registerLocalLock(appId: string, resetAfterSeconds: number) {
    const localResetAt = Date.now() + resetAfterSeconds * 1000;
    this.localLocks.set(appId, localResetAt);
    Log.warn(this.TAG, `Local memory lock registered on App ID ${appId} for ${resetAfterSeconds.toFixed(2)}s.`);
  }

  static async request(
    widgetName: string,
    appId: string,
    token: string,
    payload: Record<string, unknown>,
  ): Promise<{ success: boolean; status: number }> {
    if (this.isLocked(appId)) {
      const waitMs = this.getRemainingLockTime(appId);
      Log.warn(this.TAG, `Preemptively dropping update payload for "${widgetName}" (ID: ${appId}) to prevent 429 penalties. Backoff: ${(waitMs / 1000).toFixed(1)}s remaining.`);
      return { success: false, status: 429 };
    }

    const endpointUrl = `https://discord.com/api/v9/applications/${appId}/users/${ConfigManager.DISCORD_OWNER_USER_ID}/identities/0/profile`;
    try {
      const startTime = Date.now();
      const response = await fetch(endpointUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bot ${token}`,
          "User-Agent": "DiscordBot (https://github.com/discord/discord-api-docs, 1.0.0)",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });

      const responseTime = Date.now() - startTime;
      Log.debug(this.TAG, `Network response for "${widgetName}" in ${responseTime}ms [HTTP ${response.status}]`);

      const remaining = response.headers.get("X-RateLimit-Remaining");
      const resetAfter = response.headers.get("X-RateLimit-Reset-After");
      const remainingCount = remaining !== null ? parseInt(remaining, 10) : null;

      if (remainingCount !== null && remainingCount <= 2 && resetAfter) {
        const resetSeconds = parseFloat(resetAfter);
        Log.warn(this.TAG, `Rate-limit safety buffer triggered (${remainingCount} slots remaining <= 2). Locking for ${resetSeconds}s...`);
        this.registerLocalLock(appId, resetSeconds);
        await FirebaseManager.publishRateLimitLock(appId, widgetName, resetSeconds);
      }

      if (response.status === 429) {
        const errorJson = await response.json();
        const retryAfter = errorJson.retry_after ?? parseFloat(resetAfter ?? "10");
        Log.error(this.TAG, `HTTP STATUS 429: Rate-limit exceeded! Locking App ID ${appId} for ${retryAfter}s.`);
        this.registerLocalLock(appId, retryAfter);
        await FirebaseManager.publishRateLimitLock(appId, widgetName, retryAfter);
        return { success: false, status: 429 };
      }

      if (!response.ok) {
        const errorText = await response.text();
        Log.error(this.TAG, `Discord endpoint returned failed operation (HTTP ${response.status}): "${errorText}"`);
        return { success: false, status: response.status };
      }

      return { success: true, status: response.status };
    } catch (err) {
      Log.error(this.TAG, "Network transport anomaly caught during request dispatch:", err);
      return { success: false, status: 500 };
    }
  }
}

export class ShittimChestStatusWidget implements DiscordWidget {
  appId = ConfigManager.DEFAULT_APP_IDS.STATUS;
  name = "Shittim Chest Status";

  shouldUpdate(context: WidgetContext): Promise<boolean> {
    const elapsed = Date.now() - context.lastUpdateTime;
    const isReady = elapsed >= ConfigManager.STATUS_UPDATE_INTERVAL_MS;
    return Promise.resolve(isReady);
  }

  async getPayload(): Promise<Record<string, unknown>> {
    Log.info(this.name, "Fetching hardware telemetry payload for status widget...");
    const telemetry = await this.resolveActiveTelemetry();
    const activeNodeId = telemetry.node_id || ConfigManager.NODE_ID;

    const nodeData = FirebaseManager.getNodeMetadata(activeNodeId);
    const roleOs = telemetry.os || (nodeData && nodeData.os ? String(nodeData.os) : Deno.build.os);
    const targetTitle = telemetry.device_name || (nodeData && nodeData.device_name ? String(nodeData.device_name) : activeNodeId);

    const subtitle2Text = `Node Target: ${targetTitle}`;
    const subtitle3Text = `${roleOs.charAt(0).toUpperCase() + roleOs.slice(1)}`;

    const uptime = telemetry.uptime_ms === -1 ? 0 : telemetry.uptime_ms;
    const cpuFormatted = telemetry.cpu_load === -1 ? `Restricted / ${telemetry.cpu_speed_ghz} GHz` : `${telemetry.cpu_load}% / ${telemetry.cpu_speed_ghz} GHz`;
    const ramFormatted = `${telemetry.ram_used_gb} / ${telemetry.ram_total_gb} GB`;
    const gpuFormatted = `${telemetry.gpu_load}% (${telemetry.gpu_name})`;
    const diskFormatted = `${telemetry.disk_used_gb} / ${telemetry.disk_total_gb} GB`;
    const batteryWatts = telemetry.battery_power_w ?? 0;
    const tempFormatted = batteryWatts > 0 ? `${telemetry.temp_c}°C (${batteryWatts.toFixed(1)}W)` : `${telemetry.temp_c}°C`;

    return {
      data: {
        dynamic: [
          { type: 1, name: "cpu_val", value: cpuFormatted },
          { type: 1, name: "ram_val", value: ramFormatted },
          { type: 1, name: "gpu_val", value: gpuFormatted },
          { type: 1, name: "disk_val", value: diskFormatted },
          { type: 1, name: "temp_val", value: tempFormatted },
          { type: 2, name: "uptime_val", value: uptime },
          { type: 1, name: "subtitle_2", value: subtitle2Text },
          { type: 1, name: "subtitle_3", value: subtitle3Text },
        ],
      },
    };
  }

  private async resolveActiveTelemetry(): Promise<TelemetryData> {
    try {
      const now = Date.now();
      const allTelemetry = FirebaseManager.getAllLatestTelemetry();

      for (const [_, data] of allTelemetry) {
        if (data && data.timestamp && (now - data.timestamp < 60000)) {
          return data;
        }
      }
    } catch { /* Fallback */ }
    return await SystemTelemetry.collectMetrics();
  }

  onSuccess(): Promise<void> {
    Log.success(this.name, "Successfully updated Status Widget.");
    return Promise.resolve();
  }
}

export class ShittimChestAIWidget implements DiscordWidget {
  appId = ConfigManager.DEFAULT_APP_IDS.AI;
  name = "Shittim Chest AI";
  private lastPostedPhase: string | null = null;

  private static ASSETS = {
    arona_morning: "https://i.pximg.net/img-master/img/2026/06/22/23/56/20/146337678_p1_master1200.jpg",
    arona_combat: "https://i.pximg.net/img-master/img/2025/12/12/22/03/19/138524161_p1_master1200.jpg",
    arona_chill: "https://i.pximg.net/img-master/img/2026/05/28/22/37/45/145322363_p0_master1200.jpg",
    arona_busy: "https://i.pximg.net/img-master/img/2025/10/21/18/00/13/136536907_p0_master1200.jpg",
    arona_gacha: "https://i.pximg.net/img-master/img/2026/07/05/19/47/01/146854138_p0_master1200.jpg",
    arona_sleep: "https://i.pximg.net/img-master/img/2025/10/26/20/52/29/136732037_p0_master1200.jpg",
    plana_work: "https://i.pximg.net/img-master/img/2026/04/23/01/19/26/143876654_p1_master1200.jpg",
    plana_analyzer: "https://i.pximg.net/img-master/img/2026/07/06/19/51/01/146892878_p0_master1200.jpg",
    plana_sunset: "https://i.pximg.net/img-master/img/2026/05/04/22/29/55/144365366_p0_master1200.jpg",
    plana_night: "https://i.pximg.net/img-master/img/2026/05/09/10/53/14/144552614_p0_master1200.jpg",
    plana_deep: "https://i.pximg.net/img-master/img/2025/08/14/20/57/23/133882357_p0_master1200.jpg",
    plana_dawn: "https://i.pximg.net/img-master/img/2026/05/10/22/07/43/144622782_p0_master1200.jpg",
    icon_agenda: "https://static.wikia.nocookie.net/blue-archive/images/4/40/MP_Achievement.png",
    icon_battle: "https://static.wikia.nocookie.net/blue-archive/images/9/9a/MP_Total_War.png",
    icon_food: "https://static.wikia.nocookie.net/blue-archive/images/8/88/Parfait.png",
    icon_data: "https://static.wikia.nocookie.net/blue-archive/images/1/1e/Cube_Puzzle.png",
    icon_chat: "https://pbs.twimg.com/profile_images/1767644782887628801/-br6BlXm_400x400.jpg",
    icon_patrol: "https://static.wikia.nocookie.net/blue-archive/images/3/3e/MP_Circle.png",
    icon_gacha: "https://media.discordapp.net/attachments/878538003469987850/1528742237348036638/Arona_Plana_Purple_Gacha_Animation_crop.gif",
    icon_sleep: "https://images.steamusercontent.com/ugc/2520402300708963971/2CC83F3359331305BD0A7AEFB7CA9384A3E40E32/",
  };

  getCurrentPhaseName(): string {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const timeValue = hour + minute / 60;

    if (timeValue >= 5.0 && timeValue < 7.0) return "Phase 1: Arona Morning Sync";
    if (timeValue >= 7.0 && timeValue < 9.0) return "Phase 2: Plana File Manager";
    if (timeValue >= 9.0 && timeValue < 11.0) return "Phase 3: Arona Combat Mode";
    if (timeValue >= 11.0 && timeValue < 13.0) return "Phase 4: Arona Chill";
    if (timeValue >= 13.0 && timeValue < 15.0) return "Phase 5: Plana Analyzer";
    if (timeValue >= 15.0 && timeValue < 17.0) return "Phase 6: Arona Busy";
    if (timeValue >= 17.0 && timeValue < 19.0) return "Phase 7: Plana Sunset Mode";
    if (timeValue >= 19.0 && timeValue < 21.0) return "Phase 8: Arona Gacha Mode";
    if (timeValue >= 21.0 && timeValue < 23.0) return "Phase 9: Plana Night Focus";
    if (timeValue >= 23.0 || timeValue < 3.0) return "Phase 10: Plana Soft Night";
    if (timeValue >= 3.0 && timeValue < 4.5) return "Phase 11: Arona Sleepwalking";
    return "Phase 12: Plana Pre-Dawn Calibration";
  }

  shouldUpdate(): Promise<boolean> {
    const curCalculated = this.getCurrentPhaseName();
    const globalSynced = FirebaseManager.lastSyncedAiPhase;
    const targetRef = globalSynced ?? this.lastPostedPhase;
    return Promise.resolve(curCalculated !== targetRef);
  }

  getPayload(): Promise<Record<string, unknown>> {
    const phaseName = this.getCurrentPhaseName();
    Log.info(this.name, `Generating payload for phase: [${phaseName}]`);
    let dynamicPayload: unknown[] = [];

    switch (phaseName) {
      case "Phase 1: Arona Morning Sync":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.arona_morning,
          "Good Morning, Lia Sensei!",
          '"Shittim Chest OS successfully booted. Today is going to be great!"',
          "SCHALE Terminal Status: Online",
          "Daily Stamp Progress: Pending",
          ShittimChestAIWidget.ASSETS.icon_agenda,
          "Morning Attendance Check",
          "SCHALE Daily Work Initialization",
          0.1
        );
        break;
      case "Phase 2: Plana File Manager":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.plana_work,
          "SCHALE Daily Agenda Review",
          '"Sensei, here is the list of pending tasks and petitions for today."',
          "Document Status: 12 Petitions Awaiting Review",
          "Priority: General Student Council Requests",
          ShittimChestAIWidget.ASSETS.icon_agenda,
          "Document Review Queue",
          "Processing Kivotos Administration Requests",
          0.25
        );
        break;
      case "Phase 3: Arona Combat Mode":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.arona_combat,
          "WARNING: Decagrammaton Signal Detected!",
          '"Sensei! High energy reading detected in the outskirts of Kivotos!"',
          "Threat Level: Total Assault / Raid Active",
          "Tactical Command: Deploying Support Unit",
          ShittimChestAIWidget.ASSETS.icon_battle,
          "Raid Boss Suppression Progress",
          "HP Bar Target: Active Total Assault Boss",
          0.85
        );
        break;
      case "Phase 4: Arona Chill":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.arona_chill,
          "Lunch Time at SCHALE Office!",
          '"Sensei! Strawberry milk boosts tactical productivity by 200%!"',
          "Office Environment: Cooldown & Break",
          "A.R.O.N.A Protocol: Snack Refill Needed",
          ShittimChestAIWidget.ASSETS.icon_food,
          "Sensei's Break Duration",
          "Midday Re-energizing Interval",
          0.5
        );
        break;
      case "Phase 5: Plana Analyzer":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.plana_analyzer,
          "Tactical Data Analysis",
          '"Plana is calculating student synergy and pyroxene distribution efficiency."',
          "Data Stream: SCHALE Database Syncing",
          "Neural Link Stability: 99.8%",
          ShittimChestAIWidget.ASSETS.icon_data,
          "Combat Simulation Accuracy",
          "Calculating Optimal Team Formations",
          0.65
        );
        break;
      case "Phase 6: Arona Busy":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.arona_busy,
          "MomoTalk Inbox Overflow!",
          '"Sensei, the students are spamming messages! Please reply to them!"',
          "Pending Messages: 99+ Unread Notifications",
          "Affinity Opportunity: High Priority",
          ShittimChestAIWidget.ASSETS.icon_chat,
          "Unread MomoTalk Queue",
          "Student Relationship & Affinity Response",
          0.4
        );
        break;
      case "Phase 7: Plana Sunset Mode":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.plana_sunset,
          "Kivotos Sunset Operations",
          '"The sun is setting, Sensei. Valkyrie police forces are on patrol."',
          "District Security: Clear & Peaceful",
          "SCHALE Terminal: Switching to Evening UI",
          ShittimChestAIWidget.ASSETS.icon_patrol,
          "Daily Kivotos Safety Index",
          "District Peace Maintenance Rate",
          0.95
        );
        break;
      case "Phase 8: Arona Gacha Mode":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.arona_gacha,
          "Pyroxene Reserve Audit",
          '"Sensei, look! Are we ready for the next recruitment banner?"',
          "Vault Reserve Check: Dynamic Calibration",
          "Gacha Status: Blue Envelope Prevention Active",
          ShittimChestAIWidget.ASSETS.icon_gacha,
          "Spark Guarantee Target (200 Pulls)",
          "Current Pyroxene Savings Meter",
          0.72
        );
        break;
      case "Phase 9: Plana Night Focus":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.plana_night,
          "SCHALE Late Night Administration",
          '"Plana will stay by your side while you finish the final reports, Sensei."',
          "Office Status: Quiet Hours",
          "Protocol: Night Shift Assistance",
          ShittimChestAIWidget.ASSETS.icon_data,
          "Daily Report Completion",
          "Finalizing Kivotos Administrative Tasks",
          0.9
        );
        break;
      case "Phase 10: Plana Soft Night":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.plana_deep,
          "Shittim Chest Low Power Mode",
          '"Lia Sensei, it is time to rest. Leave the security of Shittim Chest to Plana."',
          "System Status: Sleep Mode / Low Luminescence",
          '"Good night, Sensei... May your dreams be peaceful."',
          ShittimChestAIWidget.ASSETS.icon_sleep,
          "Main System Battery Reserve",
          "Overnight Low Power Allocation",
          0.2
        );
        break;
      case "Phase 11: Arona Sleepwalking":
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.arona_sleep,
          "A.R.O.N.A Sleepwalking... Zzz...",
          '"...Zzz... Strawberry cake... No, Sensei, don\'t take my cake..."',
          "System Status: REM Sleep Subsystem",
          "Warning: Dream Data Leaking into UI",
          ShittimChestAIWidget.ASSETS.icon_sleep,
          "Dream Memory Sync",
          "Subconscious Data Processing",
          0.05
        );
        break;
      default:
        dynamicPayload = this.buildDynamic(
          ShittimChestAIWidget.ASSETS.plana_dawn,
          "Pre-Dawn Calibration",
          '"Preparing Shittim Chest OS. Dawn is approaching, Sensei."',
          "System Status: Warming Up Main Units",
          "Protocol: Daily Reset Preparation",
          ShittimChestAIWidget.ASSETS.icon_data,
          "System Warm-up Meter",
          "Pre-Boot Diagnostics",
          0.98
        );
    }
    return Promise.resolve({ data: { dynamic: dynamicPayload } });
  }

  private buildDynamic(
    hero: string,
    title: string,
    sub1: string,
    sub2: string,
    sub3: string,
    objImg: string,
    objName: string,
    objDesc: string,
    progress: number
  ) {
    return [
      { type: 3, name: "hero_image", value: { url: hero } },
      { type: 1, name: "title", value: title },
      { type: 1, name: "subtitle_1", value: sub1 },
      { type: 1, name: "subtitle_2", value: sub2 },
      { type: 1, name: "subtitle_3", value: sub3 },
      { type: 3, name: "objective_image", value: { url: objImg } },
      { type: 1, name: "name", value: objName },
      { type: 1, name: "description", value: objDesc },
      { type: 2, name: "progress_value", value: progress },
    ];
  }

  async onSuccess(): Promise<void> {
    const executed = this.getCurrentPhaseName();
    this.lastPostedPhase = executed;
    Log.success(this.name, `AI Phase updated: ${executed}`);
    await FirebaseManager.setLastAiPhase(executed);
  }
}

export class SchaleSenseiIDCardWidget implements DiscordWidget {
  appId = ConfigManager.DEFAULT_APP_IDS.SENSEI_CARD;
  name = "Schale Sensei ID Card";
  private lastPostedPayloadJson: string | null = null;
  private lastPresetIndex: number | null = null;
  private static HEADER_IMAGE_URL = "https://media.discordapp.net/attachments/807948729587335208/1539580657271963668/female-sensei.png";

  shouldUpdate(): Promise<boolean> {
    const currentPresetIndex = Math.floor(Date.now() / ConfigManager.ID_CARD_ROTATION_INTERVAL_MS) % 4;
    const presetChanged = this.lastPresetIndex !== currentPresetIndex;
    const rawData = FirebaseManager.getCachedWidgetData("sensei_id");
    const currentRawJson = JSON.stringify(rawData || {});
    const dataChanged = currentRawJson !== this.lastPostedPayloadJson;
    return Promise.resolve(presetChanged || dataChanged);
  }

  private formatNum(val: unknown): string {
    if (typeof val === "number") return val.toLocaleString("en-US");
    if (typeof val === "string") {
      const parsed = parseFloat(val.replace(/,/g, ""));
      return isNaN(parsed) ? val : parsed.toLocaleString("en-US");
    }
    return String(val || "0");
  }

  private getValue(data: Record<string, unknown>, path: string[], fallback: string): string {
    let current: any = data;
    for (const p of path) {
      if (current && typeof current === "object" && p in current) {
        current = current[p];
      } else {
        return fallback;
      }
    }
    return current !== undefined && current !== null ? String(current) : fallback;
  }

  private extractSenseiData(rawData: Record<string, unknown> | null) {
    const data = rawData || {};
    return {
      name: this.getValue(data, ["name"], "Lianion"),
      shortName: this.getValue(data, ["name_short"], "Lia Sensei"),
      region: this.getValue(data, ["region"], "Asia"),
      friendCode: this.getValue(data, ["friend_code"], "AYWYZOIZ"),
      uid: this.getValue(data, ["uid"], "4462626"),
      friendsCount: this.getValue(data, ["friends"], "17/50"),
      totalAssaultRank: this.getValue(data, ["session", "total_assault_rank"], "47891"),
      grandAssaultRank: this.getValue(data, ["session", "grand_assault_rank"], "34026"),
      tacticalChallengeRank: this.getValue(data, ["session", "tactical_challenge_rank"], "672"),
      restrictionReleaseStage: this.getValue(data, ["session", "final_restriction_stage"], "Stage 25"),
      normalMission: this.getValue(data, ["mission", "normal"], "30-5"),
      hardMission: this.getValue(data, ["mission", "hard"], "30-3"),
      totalStars: this.getValue(data, ["mission", "total_stars"], "3492"),
      tacticalParticipation: this.getValue(data, ["tactical_challenge_participation"], "227"),
      totalAssaultEntries: this.getValue(data, ["total_assault_entries"], "597"),
      totalStageClears: this.getValue(data, ["stage_clears_total"], "42880"),
      commissionClears: this.getValue(data, ["commission_clears"], "617"),
      bountyClears: this.getValue(data, ["bounty_clears"], "4094"),
      scrimmageClears: this.getValue(data, ["scrimmage_clears"], "3518"),
      clubName: this.getValue(data, ["club", "name"], "Lol1Archived"),
      clubId: this.getValue(data, ["club", "id"], "16197"),
      clubMembers: this.getValue(data, ["club", "members"], "38/50"),
      lessonAreaRank: this.getValue(data, ["lesson", "area_rank"], "139"),
      ap: this.getValue(data, ["ap"], "240/240"),
      creditPoints: this.getValue(data, ["credits"], "333,428,055"),
      pyroxenes: this.getValue(data, ["pyroxenes"], "13,918"),
      creditsEarned: this.getValue(data, ["credits_earned"], "2,288,861,876"),
      creditsSpent: this.getValue(data, ["credits_spent"], "1,955,443,821"),
      totalStudents: this.getValue(data, ["collection", "students"], "169"),
      studentLevelUps: this.getValue(data, ["collection", "student_level_ups"], "11841"),
      skillLevelUps: this.getValue(data, ["collection", "skill_level_ups"], "1379"),
      skillLv5Count: this.getValue(data, ["collection", "skill_lv5_count"], "163"),
      skillLv10Count: this.getValue(data, ["collection", "skill_lv10_count"], "9"),
      studentsRecruited: this.getValue(data, ["collection", "students_recruited"], "169"),
      students3Star: this.getValue(data, ["collection", "students_3star"], "160"),
      students5Star: this.getValue(data, ["collection", "students_5star"], "67"),
      talentsUnlocked: this.getValue(data, ["collection", "talents_unlocked"], "114"),
      recollectionLobbies: this.getValue(data, ["collection", "recollection_lobbies"], "138"),
      weaponEquipped: this.getValue(data, ["weapon", "equipped"], "67"),
      weaponLevelUps: this.getValue(data, ["weapon", "level_ups"], "1840"),
      weaponLv30: this.getValue(data, ["weapon", "lv30"], "60"),
      weaponLv40: this.getValue(data, ["weapon", "lv40"], "7"),
      weaponLv50: this.getValue(data, ["weapon", "lv50"], "2"),
      weaponLv60: this.getValue(data, ["weapon", "lv60"], "1"),
      dailyLogins: this.getValue(data, ["daily_login"], "912"),
      craftsCompleted: this.getValue(data, ["craft_completed"], "150"),
    };
  }

  getPayload(): Promise<Record<string, unknown>> {
    const rawData = FirebaseManager.getCachedWidgetData("sensei_id");
    const d = this.extractSenseiData(rawData);
    const presetIndex = Math.floor(Date.now() / ConfigManager.ID_CARD_ROTATION_INTERVAL_MS) % 4;
    Log.info(this.name, `Building Sensei ID Card preset #${presetIndex + 1} payload...`);

    let title = "";
    let subtitle1 = "";
    let subtitle2 = "";
    let subtitle3 = "";
    let stats: Array<{ val: string; lbl: string }> = [];

    switch (presetIndex) {
      case 0:
        title = `Schale Sensei ID - General Profile`;
        subtitle1 = `${d.name} (${d.shortName}) | Region: ${d.region}`;
        subtitle2 = `UID: ${d.uid} | Friend Code: ${d.friendCode}`;
        subtitle3 = `Club: ${d.clubName} (${d.clubMembers}) | ID: ${d.clubId}`;
        stats = [
          { val: `${this.formatNum(d.totalStars)} ⭐`, lbl: "Missions & Event Stars" },
          { val: d.friendsCount, lbl: "Current Friends" },
          { val: `${this.formatNum(d.dailyLogins)} Days`, lbl: "Daily Logins" },
          { val: `${this.formatNum(d.pyroxenes)} 💎`, lbl: "Pyroxenes Savings" },
          { val: `${d.totalStudents} / ${d.students3Star} 3⭐`, lbl: "Students Recruited" },
          { val: `Rank ${d.lessonAreaRank}`, lbl: "Total Area Lesson Rank" },
        ];
        break;
      case 1:
        title = `Schale Sensei ID - Battle Records`;
        subtitle1 = `Total Assault Rank: #${this.formatNum(d.totalAssaultRank)}`;
        subtitle2 = `Grand Assault Rank: #${this.formatNum(d.grandAssaultRank)}`;
        subtitle3 = `Tactical Challenge: Rank #${this.formatNum(d.tacticalChallengeRank)}`;
        stats = [
          { val: `${this.formatNum(d.totalAssaultEntries)} Times`, lbl: "Total Assault Entries" },
          { val: `${this.formatNum(d.tacticalParticipation)} Times`, lbl: "Tactical Challenge Part." },
          { val: d.restrictionReleaseStage, lbl: "Final Restriction Release" },
          { val: `${this.formatNum(d.totalStageClears)}`, lbl: "Missions & Quests Cleared" },
          { val: `${this.formatNum(d.bountyClears)}`, lbl: "Bounties Cleared" },
          { val: `${this.formatNum(d.scrimmageClears)}`, lbl: "Scrimmages Cleared" },
        ];
        break;
      case 2:
        title = `Schale Sensei ID - Collection & Arsenal`;
        subtitle1 = `Students: ${d.totalStudents} (${d.students3Star} 3⭐ / ${d.students5Star} 5⭐)`;
        subtitle2 = `Recollection Lobbies: ${d.recollectionLobbies} Unlocked`;
        subtitle3 = `Exclusive Weapons: ${d.weaponEquipped} Equipped`;
        stats = [
          { val: `${this.formatNum(d.studentLevelUps)}`, lbl: "Student Level Ups" },
          { val: `${this.formatNum(d.skillLevelUps)}`, lbl: "Skill Level Ups" },
          { val: `${d.skillLv5Count} / ${d.skillLv10Count}`, lbl: "Skill Lv.5 / Lv.10 Reached" },
          { val: `${d.talentsUnlocked}`, lbl: "Talents Unlocked" },
          { val: `${this.formatNum(d.weaponLevelUps)}`, lbl: "Weapon Level Ups" },
          { val: `${d.weaponLv30}/${d.weaponLv40}/${d.weaponLv50}/${d.weaponLv60}`, lbl: "Weapon Lv30 / 40 / 50 / 60" },
        ];
        break;
      case 3:
      default:
        title = `Schale Sensei ID - SCHALE Operations`;
        subtitle1 = `Credit Balance: ${this.formatNum(d.creditPoints)}`;
        subtitle2 = `Earned: ${this.formatNum(d.creditsEarned)} Credits`;
        subtitle3 = `Spent: ${this.formatNum(d.creditsSpent)} Credits`;
        stats = [
          { val: `${this.formatNum(d.pyroxenes)} 💎`, lbl: "Pyroxene Reserves" },
          { val: d.ap, lbl: "AP Capacity" },
          { val: `N: ${d.normalMission} | H: ${d.hardMission}`, lbl: "Campaign Progress" },
          { val: `${this.formatNum(d.commissionClears)}`, lbl: "Commissions Cleared" },
          { val: `${this.formatNum(d.craftsCompleted)}`, lbl: "Crafts Completed" },
          { val: `${d.clubMembers}`, lbl: `${d.clubName} Members` },
        ];
        break;
    }

    return Promise.resolve({
      data: {
        dynamic: [
          { type: 3, name: "top_image", value: { url: SchaleSenseiIDCardWidget.HEADER_IMAGE_URL } },
          { type: 1, name: "title", value: title },
          { type: 1, name: "subtitle_1", value: subtitle1 },
          { type: 1, name: "subtitle_2", value: subtitle2 },
          { type: 1, name: "subtitle_3", value: subtitle3 },
          { type: 1, name: "stat1_value", value: stats[0].val },
          { type: 1, name: "stat1_label", value: stats[0].lbl },
          { type: 1, name: "stat2_value", value: stats[1].val },
          { type: 1, name: "stat2_label", value: stats[1].lbl },
          { type: 1, name: "stat3_value", value: stats[2].val },
          { type: 1, name: "stat3_label", value: stats[2].lbl },
          { type: 1, name: "stat4_value", value: stats[3].val },
          { type: 1, name: "stat4_label", value: stats[3].lbl },
          { type: 1, name: "stat5_value", value: stats[4].val },
          { type: 1, name: "stat5_label", value: stats[4].lbl },
          { type: 1, name: "stat6_value", value: stats[5].val },
          { type: 1, name: "stat6_label", value: stats[5].lbl },
        ],
      },
    });
  }

  onSuccess(): Promise<void> {
    const rawData = FirebaseManager.getCachedWidgetData("sensei_id");
    this.lastPostedPayloadJson = JSON.stringify(rawData || {});
    this.lastPresetIndex = Math.floor(Date.now() / ConfigManager.ID_CARD_ROTATION_INTERVAL_MS) % 4;
    Log.success(this.name, `Sensei ID Card preset #${this.lastPresetIndex + 1} published.`);
    return Promise.resolve();
  }
}

export interface MinecraftProfileData {
  gamertag: string;
  java_name: string;
  friends: number;
  followers: number;
}

export interface MinecraftPlatformStats {
  playtime_formatted: string;
  playtime_hours: number;
  blocks_broken: number;
  mobs_defeated: number;
  distance_traveled: number;
  achievements_completed: number;
  achievements_total: number;
  achievements_percentage: number;
  achievements_in_progress: number;
  gamerscore: number;
  gamerscore_total: number;
}

export interface MinecraftMarketplaceStats {
  minecoins: number;
  owned_total: number;
  addons: number;
  skins: number;
  worlds: number;
  textures: number;
  mashups: number;
  passes: number;
  wishlist: number;
}

export interface MinecraftWidgetData {
  profile: MinecraftProfileData;
  pc: MinecraftPlatformStats;
  android: MinecraftPlatformStats;
  marketplace: MinecraftMarketplaceStats;
}

export class MinecraftBedrockWidget implements DiscordWidget {
  appId = ConfigManager.DEFAULT_APP_IDS.MINECRAFT;
  name = "Minecraft Bedrock Edition";
  private lastPostedPayloadJson: string | null = null;
  private lastPresetIndex: number | null = null;
  private static ROTATION_INTERVAL_MS = ConfigManager.MINECRAFT_ROTATION_INTERVAL_MS || 3 * 60 * 1000;

  private static DEFAULT_DATA: MinecraftWidgetData = {
    profile: {
      gamertag: "Azvylia",
      java_name: "Azvylia",
      friends: 129,
      followers: 30,
    },
    pc: {
      playtime_formatted: "7d 14h 39m",
      playtime_hours: 182,
      blocks_broken: 28844,
      mobs_defeated: 1859,
      distance_traveled: 1114277,
      achievements_completed: 24,
      achievements_total: 133,
      achievements_percentage: 19,
      achievements_in_progress: 3,
      gamerscore: 420,
      gamerscore_total: 2980,
    },
    android: {
      playtime_formatted: "12d 22h 28m",
      playtime_hours: 310,
      blocks_broken: 42380,
      mobs_defeated: 2040,
      distance_traveled: 3559362,
      achievements_completed: 16,
      achievements_total: 133,
      achievements_percentage: 13,
      achievements_in_progress: 3,
      gamerscore: 280,
      gamerscore_total: 2980,
    },
    marketplace: {
      minecoins: 161,
      owned_total: 189,
      addons: 27,
      skins: 37,
      worlds: 123,
      textures: 2,
      mashups: 0,
      passes: 0,
      wishlist: 0,
    },
  };

  shouldUpdate(): Promise<boolean> {
    const currentPresetIndex = Math.floor(Date.now() / MinecraftBedrockWidget.ROTATION_INTERVAL_MS) % 3;
    const presetChanged = this.lastPresetIndex !== currentPresetIndex;
    const rawData = FirebaseManager.getCachedWidgetData("minecraft");
    const currentRawJson = JSON.stringify(rawData || {});
    const dataChanged = currentRawJson !== this.lastPostedPayloadJson;
    return Promise.resolve(presetChanged || dataChanged);
  }

  private formatNum(val: unknown): string {
    if (typeof val === "number") return val.toLocaleString("en-US");
    if (typeof val === "string") {
      const parsed = parseFloat(val.replace(/,/g, ""));
      return isNaN(parsed) ? val : parsed.toLocaleString("en-US");
    }
    return String(val || "0");
  }

  private getValue<T>(data: Record<string, unknown> | null | undefined, path: string[], fallback: T): T {
    let current: any = data;
    for (const p of path) {
      if (current && typeof current === "object" && p in current) {
        current = current[p];
      } else {
        return fallback;
      }
    }
    if (current === undefined || current === null) {
      return fallback;
    }
    if (typeof fallback === "number") {
      const num = typeof current === "number" ? current : Number(current);
      return (isNaN(num) ? fallback : num) as T;
    }
    if (typeof fallback === "string") {
      return String(current) as T;
    }
    return current as T;
  }

  private extractMinecraftData(rawData: Record<string, unknown> | null): MinecraftWidgetData {
    const data = rawData || {};
    const d = MinecraftBedrockWidget.DEFAULT_DATA;

    const profile: MinecraftProfileData = {
      gamertag: this.getValue(data, ["profile", "gamertag"], d.profile.gamertag),
      java_name: this.getValue(data, ["profile", "java_name"], d.profile.java_name),
      friends: this.getValue(data, ["profile", "friends"], d.profile.friends),
      followers: this.getValue(data, ["profile", "followers"], d.profile.followers),
    };

    const pc: MinecraftPlatformStats = {
      playtime_formatted: this.getValue(data, ["pc", "playtime_formatted"], d.pc.playtime_formatted),
      playtime_hours: this.getValue(data, ["pc", "playtime_hours"], d.pc.playtime_hours),
      blocks_broken: this.getValue(data, ["pc", "blocks_broken"], d.pc.blocks_broken),
      mobs_defeated: this.getValue(data, ["pc", "mobs_defeated"], d.pc.mobs_defeated),
      distance_traveled: this.getValue(data, ["pc", "distance_traveled"], d.pc.distance_traveled),
      achievements_completed: this.getValue(data, ["pc", "achievements_completed"], d.pc.achievements_completed),
      achievements_total: this.getValue(data, ["pc", "achievements_total"], d.pc.achievements_total),
      achievements_percentage: this.getValue(data, ["pc", "achievements_percentage"], d.pc.achievements_percentage),
      achievements_in_progress: this.getValue(data, ["pc", "achievements_in_progress"], d.pc.achievements_in_progress),
      gamerscore: this.getValue(data, ["pc", "gamerscore"], d.pc.gamerscore),
      gamerscore_total: this.getValue(data, ["pc", "gamerscore_total"], d.pc.gamerscore_total),
    };

    const android: MinecraftPlatformStats = {
      playtime_formatted: this.getValue(data, ["android", "playtime_formatted"], d.android.playtime_formatted),
      playtime_hours: this.getValue(data, ["android", "playtime_hours"], d.android.playtime_hours),
      blocks_broken: this.getValue(data, ["android", "blocks_broken"], d.android.blocks_broken),
      mobs_defeated: this.getValue(data, ["android", "mobs_defeated"], d.android.mobs_defeated),
      distance_traveled: this.getValue(data, ["android", "distance_traveled"], d.android.distance_traveled),
      achievements_completed: this.getValue(data, ["android", "achievements_completed"], d.android.achievements_completed),
      achievements_total: this.getValue(data, ["android", "achievements_total"], d.android.achievements_total),
      achievements_percentage: this.getValue(data, ["android", "achievements_percentage"], d.android.achievements_percentage),
      achievements_in_progress: this.getValue(data, ["android", "achievements_in_progress"], d.android.achievements_in_progress),
      gamerscore: this.getValue(data, ["android", "gamerscore"], d.android.gamerscore),
      gamerscore_total: this.getValue(data, ["android", "gamerscore_total"], d.android.gamerscore_total),
    };

    const marketplace: MinecraftMarketplaceStats = {
      minecoins: this.getValue(data, ["marketplace", "minecoins"], d.marketplace.minecoins),
      owned_total: this.getValue(data, ["marketplace", "owned_total"], d.marketplace.owned_total),
      addons: this.getValue(data, ["marketplace", "addons"], d.marketplace.addons),
      skins: this.getValue(data, ["marketplace", "skins"], d.marketplace.skins),
      worlds: this.getValue(data, ["marketplace", "worlds"], d.marketplace.worlds),
      textures: this.getValue(data, ["marketplace", "textures"], d.marketplace.textures),
      mashups: this.getValue(data, ["marketplace", "mashups"], d.marketplace.mashups),
      passes: this.getValue(data, ["marketplace", "passes"], d.marketplace.passes),
      wishlist: this.getValue(data, ["marketplace", "wishlist"], d.marketplace.wishlist),
    };

    return { profile, pc, android, marketplace };
  }

  getPayload(): Promise<Record<string, unknown>> {
    const rawData = FirebaseManager.getCachedWidgetData("minecraft");
    const { profile, pc, android, marketplace } = this.extractMinecraftData(rawData);
    const presetIndex = Math.floor(Date.now() / MinecraftBedrockWidget.ROTATION_INTERVAL_MS) % 3;
    Log.info(this.name, `Building Minecraft Bedrock preset #${presetIndex + 1} payload...`);

    let title = "";
    let subtitle1 = "";
    let subtitle2 = "";
    let subtitle3 = "";
    let stats: Array<{ val: string; lbl: string }> = [];

    switch (presetIndex) {
      case 0:
        title = "Minecraft Bedrock - PC / Windows";
        subtitle1 = `Gamertag: ${profile.gamertag}`;
        subtitle2 = `Achievements: ${pc.achievements_completed}/${pc.achievements_total} (${pc.achievements_percentage}%) • ${pc.gamerscore} G`;
        subtitle3 = `Total Playtime: ${pc.playtime_formatted} (~${pc.playtime_hours} Hours)`;
        stats = [
          { val: `${this.formatNum(pc.blocks_broken)}`, lbl: "Blocks Broken" },
          { val: `${this.formatNum(pc.mobs_defeated)}`, lbl: "Mobs Defeated" },
          { val: `${this.formatNum(pc.distance_traveled)} m`, lbl: "Distance Traveled" },
          { val: `${this.formatNum(profile.friends)}`, lbl: "Xbox Friends" },
          { val: `${this.formatNum(profile.followers)}`, lbl: "Xbox Followers" },
          { val: `${this.formatNum(pc.achievements_in_progress)}`, lbl: "Quests In Progress" },
        ];
        break;

      case 1:
        title = "Minecraft Bedrock - Android Platform";
        subtitle1 = `Gamertag: ${profile.gamertag}`;
        subtitle2 = `Achievements: ${android.achievements_completed}/${android.achievements_total} (${android.achievements_percentage}%) • ${android.gamerscore} G`;
        subtitle3 = `Total Playtime: ${android.playtime_formatted} (~${android.playtime_hours} Hours)`;
        stats = [
          { val: `${this.formatNum(android.blocks_broken)}`, lbl: "Blocks Broken" },
          { val: `${this.formatNum(android.mobs_defeated)}`, lbl: "Mobs Defeated" },
          { val: `${this.formatNum(android.distance_traveled)} m`, lbl: "Distance Traveled" },
          { val: `${this.formatNum(profile.friends)}`, lbl: "Xbox Friends" },
          { val: `${this.formatNum(profile.followers)}`, lbl: "Xbox Followers" },
          { val: `${this.formatNum(android.achievements_in_progress)}`, lbl: "Quests In Progress" },
        ];
        break;

      case 2:
      default:
        title = "Minecraft Marketplace & Summary";
        subtitle1 = `Java Profile: ${profile.java_name}`;
        subtitle2 = `Bedrock Wallet: ${this.formatNum(marketplace.minecoins)} Minecoins`;
        subtitle3 = `Total Owned Items: ${this.formatNum(marketplace.owned_total)} Content Packs`;
        stats = [
          { val: `${this.formatNum(marketplace.worlds)}`, lbl: "Owned Worlds" },
          { val: `${this.formatNum(marketplace.skins)}`, lbl: "Owned Skins" },
          { val: `${this.formatNum(marketplace.addons)}`, lbl: "Owned Add-Ons" },
          { val: `${this.formatNum(marketplace.textures)}`, lbl: "Texture Packs" },
          { val: `${this.formatNum(pc.playtime_hours + android.playtime_hours)} Hours`, lbl: "Combined Playtime" },
          { val: `${this.formatNum(pc.blocks_broken + android.blocks_broken)}`, lbl: "Total Blocks Mined" },
        ];
        break;
    }

    return Promise.resolve({
      data: {
        dynamic: [
          { type: 1, name: "title", value: title },
          { type: 1, name: "subtitle_1", value: subtitle1 },
          { type: 1, name: "subtitle_2", value: subtitle2 },
          { type: 1, name: "subtitle_3", value: subtitle3 },
          { type: 1, name: "stat1_value", value: stats[0].val },
          { type: 1, name: "stat1_label", value: stats[0].lbl },
          { type: 1, name: "stat2_value", value: stats[1].val },
          { type: 1, name: "stat2_label", value: stats[1].lbl },
          { type: 1, name: "stat3_value", value: stats[2].val },
          { type: 1, name: "stat3_label", value: stats[2].lbl },
          { type: 1, name: "stat4_value", value: stats[3].val },
          { type: 1, name: "stat4_label", value: stats[3].lbl },
          { type: 1, name: "stat5_value", value: stats[4].val },
          { type: 1, name: "stat5_label", value: stats[4].lbl },
          { type: 1, name: "stat6_value", value: stats[5].val },
          { type: 1, name: "stat6_label", value: stats[5].lbl },
        ],
      },
    });
  }

  onSuccess(_payload?: Record<string, unknown>): Promise<void> {
    const rawData = FirebaseManager.getCachedWidgetData("minecraft");
    this.lastPostedPayloadJson = JSON.stringify(rawData || {});
    this.lastPresetIndex = Math.floor(Date.now() / MinecraftBedrockWidget.ROTATION_INTERVAL_MS) % 3;
    Log.success(this.name, `Minecraft Bedrock preset #${this.lastPresetIndex + 1} published.`);
    return Promise.resolve();
  }
}

export interface GitHubStatsData {
  profile: {
    username: string;
    display_name: string;
    affiliation: string;
    account_tier: string;
    followers: number;
    following: number;
    badges_count: number;
    orgs_count: number;
  };
  metrics: {
    stars_earned: number;
    total_commits: number;
    total_prs: number;
    prs_merged: number;
    prs_reviewed: number;
    total_issues: number;
    lifetime_contributions: number;
    current_year_contributions: number;
  };
  contributed_to: {
    core_repositories: string;
    recent_repositories: string;
  };
}

export class GitHubLiveStatsWidget implements DiscordWidget {
  appId = ConfigManager.DEFAULT_APP_IDS.GITHUB;
  name = "GitHub Live Stats";
  private lastPostedPayloadJson: string | null = null;
  private lastPresetIndex: number | null = null;
  private static ROTATION_INTERVAL_MS = 3 * 60 * 1000;

  private static DEFAULT_DATA: GitHubStatsData = {
    profile: {
      username: "Azvyl",
      display_name: "Azvylia Nekonova",
      affiliation: "@KirizaNetwork",
      account_tier: "GitHub PRO",
      followers: 65,
      following: 25,
      badges_count: 4,
      orgs_count: 5,
    },
    metrics: {
      stars_earned: 32,
      total_commits: 1050,
      total_prs: 45,
      prs_merged: 38,
      prs_reviewed: 16,
      total_issues: 24,
      lifetime_contributions: 1249,
      current_year_contributions: 50,
    },
    contributed_to: {
      core_repositories: "PMMP, GeyserMC, KirizaNetwork, axolotl-pm, Altay, df-mc",
      recent_repositories: "sanctum-terminal, sorting_lab, Azvyl, mcpelauncher-nekocmd, PMServerUI",
    },
  };

  shouldUpdate(): Promise<boolean> {
    const currentPresetIndex = Math.floor(Date.now() / GitHubLiveStatsWidget.ROTATION_INTERVAL_MS) % 2;
    const presetChanged = this.lastPresetIndex !== currentPresetIndex;
    const rawData = FirebaseManager.getCachedWidgetData("github");
    const currentRawJson = JSON.stringify(rawData || {});
    const dataChanged = currentRawJson !== this.lastPostedPayloadJson;
    return Promise.resolve(presetChanged || dataChanged);
  }

  private formatNum(val: unknown): string {
    if (typeof val === "number") return val.toLocaleString("en-US");
    if (typeof val === "string") {
      const parsed = parseFloat(val.replace(/,/g, ""));
      return isNaN(parsed) ? val : parsed.toLocaleString("en-US");
    }
    return String(val || "0");
  }

  private getValue<T>(data: Record<string, unknown> | null | undefined, path: string[], fallback: T): T {
    let current: any = data;
    for (const p of path) {
      if (current && typeof current === "object" && p in current) {
        current = current[p];
      } else {
        return fallback;
      }
    }
    if (current === undefined || current === null) {
      return fallback;
    }
    if (typeof fallback === "number") {
      const num = typeof current === "number" ? current : Number(current);
      return (isNaN(num) ? fallback : num) as T;
    }
    if (typeof fallback === "string") {
      return String(current) as T;
    }
    return current as T;
  }

  private extractGitHubData(rawData: Record<string, unknown> | null): GitHubStatsData {
    const data = rawData || {};
    const d = GitHubLiveStatsWidget.DEFAULT_DATA;

    const profile = {
      username: this.getValue(data, ["profile", "username"], d.profile.username),
      display_name: this.getValue(data, ["profile", "display_name"], d.profile.display_name),
      affiliation: this.getValue(data, ["profile", "affiliation"], d.profile.affiliation),
      account_tier: this.getValue(data, ["profile", "account_tier"], d.profile.account_tier),
      followers: this.getValue(data, ["profile", "followers"], d.profile.followers),
      following: this.getValue(data, ["profile", "following"], d.profile.following),
      badges_count: this.getValue(data, ["profile", "badges_count"], d.profile.badges_count),
      orgs_count: this.getValue(data, ["profile", "orgs_count"], d.profile.orgs_count),
    };

    const metrics = {
      stars_earned: this.getValue(data, ["metrics", "stars_earned"], d.metrics.stars_earned),
      total_commits: this.getValue(data, ["metrics", "total_commits"], d.metrics.total_commits),
      total_prs: this.getValue(data, ["metrics", "total_prs"], d.metrics.total_prs),
      prs_merged: this.getValue(data, ["metrics", "prs_merged"], d.metrics.prs_merged),
      prs_reviewed: this.getValue(data, ["metrics", "prs_reviewed"], d.metrics.prs_reviewed),
      total_issues: this.getValue(data, ["metrics", "total_issues"], d.metrics.total_issues),
      lifetime_contributions: this.getValue(data, ["metrics", "lifetime_contributions"], d.metrics.lifetime_contributions),
      current_year_contributions: this.getValue(data, ["metrics", "current_year_contributions"], d.metrics.current_year_contributions),
    };

    const contributed_to = {
      core_repositories: this.getValue(data, ["contributed_to", "core_repositories"], d.contributed_to.core_repositories),
      recent_repositories: this.getValue(data, ["contributed_to", "recent_repositories"], d.contributed_to.recent_repositories),
    };

    return { profile, metrics, contributed_to };
  }

  getPayload(): Promise<Record<string, unknown>> {
    const rawData = FirebaseManager.getCachedWidgetData("github");
    const { profile, metrics, contributed_to } = this.extractGitHubData(rawData);
    const presetIndex = Math.floor(Date.now() / GitHubLiveStatsWidget.ROTATION_INTERVAL_MS) % 2;
    Log.info(this.name, `Building GitHub Live Stats preset #${presetIndex + 1} payload...`);

    let title = "";
    let subtitle1 = "";
    let subtitle2 = "";
    let subtitle3 = "";
    let stats: Array<{ val: string; lbl: string }> = [];

    switch (presetIndex) {
      case 0:
        title = `GitHub Profile - ${profile.username}`;
        subtitle1 = `Backend Developer • ${profile.affiliation}`;
        subtitle2 = `Core Stack: TS/JS • PHP • Java • Go`;
        subtitle3 = `Contributed to: ${contributed_to.core_repositories}`;
        stats = [
          { val: this.formatNum(metrics.stars_earned), lbl: "Total Stars Earned" },
          { val: this.formatNum(metrics.total_commits), lbl: "Total Commits" },
          { val: this.formatNum(metrics.total_prs), lbl: "Total PRs" },
          { val: this.formatNum(metrics.prs_merged), lbl: "PRs Merged" },
          { val: this.formatNum(metrics.prs_reviewed), lbl: "PRs Reviewed" },
          { val: this.formatNum(metrics.total_issues), lbl: "Total Issues" },
        ];
        break;

      case 1:
      default:
        title = "GitHub Activity Analytics";
        subtitle1 = `User: @${profile.username} (${profile.display_name})`;
        subtitle2 = `Account Tier: ${profile.account_tier}`;
        subtitle3 = `Contributed to: ${contributed_to.recent_repositories}`;
        stats = [
          { val: `${this.formatNum(metrics.lifetime_contributions)}+`, lbl: "Lifetime Activity" },
          { val: this.formatNum(metrics.current_year_contributions), lbl: "2026 Activity" },
          { val: this.formatNum(profile.followers), lbl: "Followers" },
          { val: this.formatNum(profile.following), lbl: "Following" },
          { val: this.formatNum(profile.badges_count), lbl: "Profile Badges" },
          { val: `${this.formatNum(profile.orgs_count)} Orgs`, lbl: "Associated Orgs" },
        ];
        break;
    }

    return Promise.resolve({
      data: {
        dynamic: [
          { type: 1, name: "title", value: title },
          { type: 1, name: "subtitle_1", value: subtitle1 },
          { type: 1, name: "subtitle_2", value: subtitle2 },
          { type: 1, name: "subtitle_3", value: subtitle3 },
          { type: 1, name: "stat1_value", value: stats[0].val },
          { type: 1, name: "stat1_label", value: stats[0].lbl },
          { type: 1, name: "stat2_value", value: stats[1].val },
          { type: 1, name: "stat2_label", value: stats[1].lbl },
          { type: 1, name: "stat3_value", value: stats[2].val },
          { type: 1, name: "stat3_label", value: stats[2].lbl },
          { type: 1, name: "stat4_value", value: stats[3].val },
          { type: 1, name: "stat4_label", value: stats[3].lbl },
          { type: 1, name: "stat5_value", value: stats[4].val },
          { type: 1, name: "stat5_label", value: stats[4].lbl },
          { type: 1, name: "stat6_value", value: stats[5].val },
          { type: 1, name: "stat6_label", value: stats[5].lbl },
        ],
      },
    });
  }

  onSuccess(_payload?: Record<string, unknown>): Promise<void> {
    const rawData = FirebaseManager.getCachedWidgetData("github");
    this.lastPostedPayloadJson = JSON.stringify(rawData || {});
    this.lastPresetIndex = Math.floor(Date.now() / GitHubLiveStatsWidget.ROTATION_INTERVAL_MS) % 2;
    Log.success(this.name, `GitHub Live Stats preset #${this.lastPresetIndex + 1} published.`);
    return Promise.resolve();
  }
}

export class WidgetSchedulerEngine {
  private static TAG = "WidgetScheduler";
  private static isProcessing = false;
  private static intervalId: ReturnType<typeof setInterval> | null = null;
  private static isRunning = false;

  static async start() {
    if (this.isRunning) {
      Log.warn(this.TAG, "Widget Scheduler Engine is already running.");
      return;
    }
    this.isRunning = true;
    Log.info(this.TAG, "Starting Discord Widget Scheduler Engine...");
    const widgets: DiscordWidget[] = [
      new ShittimChestStatusWidget(),
      new ShittimChestAIWidget(),
      new SchaleSenseiIDCardWidget(),
      new MinecraftBedrockWidget(),
      new GitHubLiveStatsWidget(),
    ];

    const tokens: Record<string, string> = {
      [ConfigManager.DEFAULT_APP_IDS.STATUS]: Deno.env.get("TOKEN_SHITTIM_CHEST_STATUS") || "",
      [ConfigManager.DEFAULT_APP_IDS.AI]: Deno.env.get("TOKEN_SHITTIM_CHEST_AI") || "",
      [ConfigManager.DEFAULT_APP_IDS.SENSEI_CARD]: Deno.env.get("TOKEN_SENSEI_ID_CARD") || "",
      [ConfigManager.DEFAULT_APP_IDS.MINECRAFT]: Deno.env.get("TOKEN_MINECRAFT_BEDROCK") || "",
      [ConfigManager.DEFAULT_APP_IDS.GITHUB]: Deno.env.get("TOKEN_GITHUB_STATS") || "",
    };

    const lastUpdates = new Map<string, number>();

    this.intervalId = setInterval(async () => {
      if (!this.isRunning || this.isProcessing) return;
      this.isProcessing = true;
      try {
        for (const w of widgets) {
          if (!this.isRunning) break;
          const token = tokens[w.appId];
          if (!token) continue;
          const last = lastUpdates.get(w.appId) || 0;
          const context: WidgetContext = {
            lastUpdateTime: last,
            currentDeviceRole: ConfigManager.NODE_ID,
          };
          const needsUpdate = await w.shouldUpdate(context);
          if (!this.isRunning) break;
          if (needsUpdate && !RateLimitedHttpClient.isLocked(w.appId)) {
            const payload = await w.getPayload();
            if (!this.isRunning) break;
            const res = await RateLimitedHttpClient.request(w.name, w.appId, token, payload);
            if (res.success) {
              lastUpdates.set(w.appId, Date.now());
              await w.onSuccess(payload);
            }
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      } catch (err) {
        Log.error(this.TAG, "Widget scheduler iteration error:", err);
      } finally {
        this.isProcessing = false;
      }
    }, 1000);
  }

  static async stop(): Promise<void> {
    if (!this.isRunning && this.intervalId === null) {
      return;
    }
    Log.warn(this.TAG, "Stopping Discord Widget Scheduler Engine...");
    this.isRunning = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    let waited = 0;
    while (this.isProcessing && waited < 3000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    this.isProcessing = false;
    Log.success(this.TAG, "Discord Widget Scheduler Engine stopped successfully.");
  }
}
