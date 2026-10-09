import { ref, serverTimestamp, set } from "firebase/database";
import { ConfigManager } from "./config.ts";
import { DB_PATHS, FirebaseManager } from "./firebase.ts";
import { Log } from "./logger.ts";

export interface TelemetryData {
  cpu_load: number;
  cpu_speed_ghz: number;
  ram_used_gb: number;
  ram_total_gb: number;
  gpu_load: number;
  gpu_name: string;
  battery_power_w: number;
  disk_used_gb: number;
  disk_total_gb: number;
  temp_c: number;
  uptime_ms: number;
  timestamp: number;
  node_id: string;
  device_name: string;
  os: string;
}

export class SystemTelemetry {
  private static TAG = "Telemetry";
  private static prevCpuTicks: { active: number; total: number } | null = null;
  private static prevGpuBusy: { busy: number; total: number } | null = null;
  private static prevRc6: { rc6: number; time: number } | null = null;
  private static cachedGpuName: string | null = null;

  static async startReporting() {
    Log.info(
      this.TAG,
      `Starting 15s telemetry loop for node: [${ConfigManager.NODE_ID}] (${ConfigManager.NODE_NAME})...`,
    );

    const report = async () => {
      try {
        const data = await this.collectMetrics();
        const path = `${DB_PATHS.TELEMETRY}/${ConfigManager.NODE_ID}`;

        Log.debug(
          this.TAG,
          `[DB SEND] Publishing system telemetry payload (set) -> Path: "${path}"`,
          {
            cpu: `${data.cpu_load}% (${data.cpu_speed_ghz}GHz)`,
            ram: `${data.ram_used_gb}/${data.ram_total_gb}GB`,
            gpu: `${data.gpu_load}% (${data.gpu_name})`,
            battery: `${data.battery_power_w}W`,
            temp: `${data.temp_c}°C`,
          },
        );

        await set(ref(FirebaseManager.db, path), {
          ...data,
          timestamp: serverTimestamp(),
        });

        Log.debug(
          this.TAG,
          `[TELEMETRY SUCCESS] Node: ${ConfigManager.NODE_ID} (${data.os}) | CPU: ${data.cpu_load}% (${data.cpu_speed_ghz}GHz) | RAM: ${data.ram_used_gb}/${data.ram_total_gb}GB | GPU: ${data.gpu_load}% (${data.gpu_name}) | Battery: ${data.battery_power_w}W | Disk: ${data.disk_used_gb}/${data.disk_total_gb}GB | Temp: ${data.temp_c}°C | Uptime: ${data.uptime_ms}ms`,
        );
      } catch (e) {
        Log.error(this.TAG, "Telemetry submission failed:", e);
      }
    };

    await report();
    setInterval(report, 15000);
  }

  static async collectMetrics(): Promise<TelemetryData> {
    const [cpu, ram, gpu, batteryPower, disk, temp, uptime] = await Promise.all([
      this.getCpuMetrics(),
      this.getRamMetrics(),
      this.getGpuMetrics(),
      this.getBatteryPower(),
      this.getDiskMetrics(),
      this.getThermalMetrics(),
      this.getUptimeMs(),
    ]);

    return {
      cpu_load: cpu.load,
      cpu_speed_ghz: cpu.speedGhz,
      ram_used_gb: ram.usedGb,
      ram_total_gb: ram.totalGb,
      gpu_load: gpu.load,
      gpu_name: gpu.name,
      battery_power_w: batteryPower,
      disk_used_gb: disk.usedGb,
      disk_total_gb: disk.totalGb,
      temp_c: temp,
      uptime_ms: uptime,
      timestamp: Date.now(),
      node_id: ConfigManager.NODE_ID,
      device_name: ConfigManager.NODE_NAME,
      os: Deno.build.os,
    };
  }

  private static async getCpuMetrics(): Promise<{ load: number; speedGhz: number }> {
    let load = -1;
    let speedGhz = -1;

    try {
      if (Deno.build.os === "windows") {
        const psScript = `
          $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 LoadPercentage, MaxClockSpeed, CurrentClockSpeed
          $perf = Get-Counter '\\Processor Information(_Total)\\% Processor Performance' -ErrorAction SilentlyContinue
          $scale = if ($perf) { $perf.CounterSamples[0].CookedValue / 100 } else { 1 }
          $curSpeed = [math]::Round(($cpu.MaxClockSpeed * $scale) / 1000, 2)
          [PSCustomObject]@{ LoadPercentage = $cpu.LoadPercentage; SpeedGhz = $curSpeed } | ConvertTo-Json
        `;
        const cmd = new Deno.Command("powershell", {
          args: ["-NoProfile", "-Command", psScript],
        });
        const out = await cmd.output();
        if (out.success) {
          const parsed = JSON.parse(new TextDecoder().decode(out.stdout).trim());
          if (typeof parsed.LoadPercentage === "number") load = parsed.LoadPercentage;
          if (typeof parsed.SpeedGhz === "number" && parsed.SpeedGhz > 0) {
            speedGhz = parsed.SpeedGhz;
          }
        }
      } else {
        try {
          const readProcStat = async () => {
            const stat = await Deno.readTextFile("/proc/stat");
            const cpuLine = stat.split("\n").find((l) => l.startsWith("cpu "));
            if (!cpuLine) return null;
            const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
            const active = parts[0] + parts[1] + parts[2] + parts[5] + parts[6] + parts[7];
            const total = active + parts[3] + parts[4];
            return { active, total };
          };
          const t1 = await readProcStat();
          if (t1) {
            if (this.prevCpuTicks && this.prevCpuTicks.total > 0) {
              const activeDelta = t1.active - this.prevCpuTicks.active;
              const totalDelta = t1.total - this.prevCpuTicks.total;
              load = totalDelta > 0
                ? Math.min(100, Math.max(0, Math.round((activeDelta / totalDelta) * 100)))
                : 0;
            } else {
              await new Promise((r) => setTimeout(r, 100));
              const t2 = await readProcStat();
              if (t2) {
                const activeDelta = t2.active - t1.active;
                const totalDelta = t2.total - t1.total;
                load = totalDelta > 0
                  ? Math.min(100, Math.max(0, Math.round((activeDelta / totalDelta) * 100)))
                  : 0;
              }
            }
            if (t1) this.prevCpuTicks = t1;
          }
        } catch {
          // Fallback to top or loadavg
        }

        if (load === -1) {
          try {
            const cmd = new Deno.Command("top", { args: ["-n", "1", "-b"] });
            const out = await cmd.output();
            if (out.success) {
              const txt = new TextDecoder().decode(out.stdout);
              const idleMatch = txt.match(/([\d\.]+)\%\s*idle/i) || txt.match(/([\d\.]+)\%\s*id/i);
              const usrSysMatch = txt.match(/User\s+([\d\.]+)\%,\s+System\s+([\d\.]+)\%/i) ||
                txt.match(/(\d+)%\s*usr\s+(\d+)%\s*sys/i) ||
                txt.match(/CPU:\s*([\d\.]+)%\s*usr\s*([\d\.]+)%\s*sys/i);
              if (idleMatch) {
                const idleVal = parseFloat(idleMatch[1]);
                load = idleVal <= 100 ? Math.min(100, Math.max(0, Math.round(100 - idleVal))) : load;
              }
              if (load === -1 && usrSysMatch) {
                load = Math.min(
                  100,
                  Math.max(0, Math.round(parseFloat(usrSysMatch[1]) + parseFloat(usrSysMatch[2]))),
                );
              }
            }
          } catch {
            // Suppress
          }
        }

        if (load === -1) {
          try {
            const loadavg = await Deno.readTextFile("/proc/loadavg");
            const load1min = parseFloat(loadavg.trim().split(/\s+/)[0]);
            let cores = 1;
            try {
              if (typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number") {
                cores = navigator.hardwareConcurrency;
              } else {
                const cpuinfo = await Deno.readTextFile("/proc/cpuinfo");
                const matches = cpuinfo.match(/^processor\s*:/gm);
                if (matches && matches.length > 0) cores = matches.length;
              }
            } catch {
              cores = 4;
            }
            if (!isNaN(load1min) && cores > 0) {
              load = Math.min(100, Math.max(0, Math.round((load1min / cores) * 100)));
            }
          } catch {
            // Suppress
          }
        }

        try {
          const freqPaths: string[] = [];
          for (let i = 0; i < 16; i++) {
            freqPaths.push(
              `/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`,
              `/sys/devices/system/cpu/cpufreq/policy${i}/scaling_cur_freq`,
              `/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_cur_freq`,
              `/sys/devices/system/cpu/cpufreq/policy${i}/cpuinfo_cur_freq`,
            );
          }
          let foundKhz = 0;
          for (const p of freqPaths) {
            try {
              const freqStr = await Deno.readTextFile(p);
              const khz = parseInt(freqStr.trim(), 10);
              if (!isNaN(khz) && khz > 0) {
                foundKhz = khz;
                break;
              }
            } catch {
              continue;
            }
          }
          if (foundKhz > 0) {
            speedGhz = parseFloat((foundKhz / 1000000).toFixed(2));
          } else {
            const cpuinfo = await Deno.readTextFile("/proc/cpuinfo");
            const matches = [...cpuinfo.matchAll(/cpu MHz\s*:\s*([\d\.]+)/gi)];
            if (matches.length > 0) {
              const avgMhz = matches.reduce((acc, m) => acc + parseFloat(m[1]), 0) / matches.length;
              speedGhz = parseFloat((avgMhz / 1000).toFixed(2));
            }
          }
        } catch {
          // Suppress
        }

        if (speedGhz <= 0) {
          try {
            const cmd = new Deno.Command("lscpu");
            const out = await cmd.output();
            if (out.success) {
              const txt = new TextDecoder().decode(out.stdout);
              const mhzMatch = txt.match(/CPU\s+max\s+MHz:\s*([\d\.]+)/i) ||
                txt.match(/CPU\s+MHz:\s*([\d\.]+)/i);
              if (mhzMatch) {
                speedGhz = parseFloat((parseFloat(mhzMatch[1]) / 1000).toFixed(2));
              }
            }
          } catch {
            // Suppress
          }
        }

        if (speedGhz <= 0) {
          speedGhz = 2.40;
        }
      }
    } catch (e) {
      Log.debug(this.TAG, "[CPU DEBUG] Exception in getCpuMetrics:", e);
    }

    Log.debug(this.TAG, `[TELEMETRY VAR SET] CPU load resolved to ${load}% and speed to ${speedGhz} GHz`);
    return { load, speedGhz };
  }

  private static async getRamMetrics(): Promise<{ usedGb: number; totalGb: number }> {
    try {
      if (Deno.build.os === "windows") {
        const cmd = new Deno.Command("powershell", {
          args: [
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory) | ConvertTo-Json",
          ],
        });
        const out = await cmd.output();
        if (out.success) {
          const parsed = JSON.parse(new TextDecoder().decode(out.stdout).trim());
          const totalGb = parseFloat((parsed.TotalVisibleMemorySize / 1048576).toFixed(1));
          const freeGb = parseFloat((parsed.FreePhysicalMemory / 1048576).toFixed(1));
          const usedGb = parseFloat((totalGb - freeGb).toFixed(1));
          Log.debug(this.TAG, `[TELEMETRY VAR SET] RAM parsed: used = ${usedGb} GB, total = ${totalGb} GB`);
          return { usedGb, totalGb };
        }
      } else {
        const meminfo = await Deno.readTextFile("/proc/meminfo");
        const lines = meminfo.split("\n");
        const findVal = (k: string) => {
          const l = lines.find((line) => line.startsWith(k));
          return l ? parseInt(l.replace(/\D/g, ""), 10) : 0;
        };
        const totalKb = findVal("MemTotal:");
        const availKb = findVal("MemAvailable:") || findVal("MemFree:");
        if (totalKb > 0) {
          const usedGb = parseFloat(((totalKb - availKb) / 1048576).toFixed(1));
          const totalGb = parseFloat((totalKb / 1048576).toFixed(1));
          Log.debug(this.TAG, `[TELEMETRY VAR SET] RAM /proc/meminfo: used = ${usedGb} GB, total = ${totalGb} GB`);
          return { usedGb, totalGb };
        }
      }
    } catch (e) {
      Log.debug(this.TAG, "[RAM DEBUG] Exception:", e);
    }
    return { usedGb: -1, totalGb: -1 };
  }

  private static async getGpuMetrics(): Promise<{ load: number; name: string }> {
    let load = -1;
    let name = this.cachedGpuName || "";

    try {
      if (Deno.build.os === "windows") {
        if (!name) {
          try {
            const nameScript = `
              $g = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -and $_.Status -eq 'OK' } | Select-Object -First 1 Name
              if (-not $g) { $g = Get-CimInstance Win32_VideoController | Select-Object -First 1 Name }
              if ($g) { $g.Name } else { "Generic Video Controller" }
            `;
            const nameCmd = new Deno.Command("powershell", {
              args: ["-NoProfile", "-Command", nameScript],
            });
            const nameOut = await nameCmd.output();
            if (nameOut.success) {
              const res = new TextDecoder().decode(nameOut.stdout).trim();
              if (res) name = res;
            }
          } catch {
            name = "DirectX Graphics Adapter";
          }
          this.cachedGpuName = name;
        }

        try {
          const psScript = `
            $ErrorActionPreference = 'SilentlyContinue'
            $t1 = [System.Diagnostics.Stopwatch]::StartNew()
            $c1 = (Get-Counter '\\GPU Engine(*engtype_3D*)\\Running Time' -ErrorAction SilentlyContinue).CounterSamples
            if (-not $c1) {
              $c1 = (Get-Counter '\\GPU Engine(*)\\Running Time' -ErrorAction SilentlyContinue).CounterSamples | Where-Object { $_.InstanceName -like "*engtype_3D*" -or $_.InstanceName -like "*engtype_Render*" }
            }
            Start-Sleep -Milliseconds 500
            $t1.Stop()
            $c2 = (Get-Counter '\\GPU Engine(*engtype_3D*)\\Running Time' -ErrorAction SilentlyContinue).CounterSamples
            if (-not $c2) {
              $c2 = (Get-Counter '\\GPU Engine(*)\\Running Time' -ErrorAction SilentlyContinue).CounterSamples | Where-Object { $_.InstanceName -like "*engtype_3D*" -or $_.InstanceName -like "*engtype_Render*" }
            }
            if ($c1 -and $c2) {
              $elapsedNs = $t1.Elapsed.TotalMilliseconds * 10000
              $maxPct = 0
              foreach ($s2 in $c2) {
                $s1 = $c1 | Where-Object { $_.Path -eq $s2.Path } | Select-Object -First 1
                if ($s1) {
                  $timeDiff = $s2.RawValue - $s1.RawValue
                  if ($timeDiff -gt 0 -and $elapsedNs -gt 0) {
                    $pct = ($timeDiff / $elapsedNs) * 100
                    if ($pct -gt $maxPct) { $maxPct = $pct }
                  }
                }
              }
              [math]::Round($maxPct)
            } else { 0 }
          `;
          const cmd = new Deno.Command("powershell", {
            args: ["-NoProfile", "-NonInteractive", "-Command", psScript],
          });
          const out = await cmd.output();
          if (out.success) {
            const raw = new TextDecoder().decode(out.stdout).trim();
            const val = parseInt(raw, 10);
            if (!isNaN(val) && val >= 0) {
              load = Math.min(100, Math.max(0, val));
            }
          }
        } catch {
          // Suppress
        }
      } else {
        if (!name) {
          name = await this.detectLinuxGpuName();
          this.cachedGpuName = name;
        }

        load = await this.detectLinuxGpuLoad();
      }
    } catch (err) {
      Log.debug(this.TAG, "[GPU DEBUG] Exception in getGpuMetrics:", err);
    }

    if (!name) name = "Display Controller";
    Log.debug(this.TAG, `[TELEMETRY VAR SET] GPU metrics: load = ${load}%, name = "${name}"`);
    return { load, name };
  }

  private static async detectLinuxGpuName(): Promise<string> {
    try {
      const cmd = new Deno.Command("lspci");
      const out = await cmd.output();
      if (out.success) {
        const text = new TextDecoder().decode(out.stdout);
        const vgaLine = text.split("\n").find((l) => /VGA compatible controller|3D controller|Display controller/i.test(l));
        if (vgaLine) {
          const bracketMatch = vgaLine.match(/\[(.*?)\]/);
          if (bracketMatch && bracketMatch[1]) {
            return bracketMatch[1].trim();
          }

          const parts = vgaLine.split(":");
          if (parts.length >= 3) {
            let clean = parts.slice(2).join(":").trim();
            clean = clean.replace(/\(rev\s+[a-f0-9]+\)/i, "").trim();
            if (clean.length > 50) {
              clean = clean.slice(0, 47) + "...";
            }
            if (clean) return clean;
          }
        }
      }
    } catch {
      // Suppress
    }

    try {
      const cmd = new Deno.Command("getprop", { args: ["ro.hardware.egl"] });
      const out = await cmd.output();
      if (out.success) {
        const egl = new TextDecoder().decode(out.stdout).trim();
        if (egl.toLowerCase().includes("adreno")) return "Qualcomm Adreno GPU";
        if (egl.toLowerCase().includes("mali")) return "ARM Mali GPU";
        if (egl) return `${egl.toUpperCase()} GPU`;
      }
    } catch {
      // Suppress
    }

    try {
      const cmd = new Deno.Command("getprop", { args: ["ro.soc.model"] });
      const out = await cmd.output();
      if (out.success) {
        const soc = new TextDecoder().decode(out.stdout).trim();
        if (soc) return `SoC GPU (${soc})`;
      }
    } catch {
      // Suppress
    }

    try {
      for (const card of ["card0", "card1", "card2"]) {
        try {
          const driverLink = await Deno.readLink(`/sys/class/drm/${card}/device/driver`);
          if (driverLink.includes("i915") || driverLink.includes("xe")) {
            return "Intel Graphics Controller";
          } else if (driverLink.includes("amdgpu") || driverLink.includes("radeon")) {
            return "AMD Radeon Graphics";
          } else if (driverLink.includes("nouveau") || driverLink.includes("nvidia")) {
            return "NVIDIA Graphics Controller";
          } else if (driverLink.includes("virtio")) {
            return "VirtIO GPU Adapter";
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Suppress
    }

    try {
      const kgslStat = await Deno.stat("/sys/class/kgsl/kgsl-3d0");
      if (kgslStat.isDirectory) {
        return "Qualcomm Adreno GPU";
      }
    } catch {
      // Suppress
    }

    try {
      for await (const entry of Deno.readDir("/sys/class/devfreq")) {
        const n = entry.name.toLowerCase();
        if (n.includes("mali")) return "ARM Mali GPU";
        if (n.includes("kgsl") || n.includes("qcom") || n.includes("adreno")) return "Qualcomm Adreno GPU";
        if (n.includes("gpu")) return "Embedded GPU Controller";
      }
    } catch {
      // Suppress
    }

    return "Integrated Graphics Adapter";
  }

  private static async detectLinuxGpuLoad(): Promise<number> {
    let load = -1;

    const kgslBusyPaths = [
      "/sys/class/kgsl/kgsl-3d0/gpubusy",
      "/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage",
    ];
    for (const p of kgslBusyPaths) {
      try {
        const busyStr = await Deno.readTextFile(p);
        const parts = busyStr.trim().split(/\s+/).map(Number);
        if (parts.length >= 2 && parts[1] > 0) {
          const busyTicks = parts[0];
          const totalTicks = parts[1];
          if (this.prevGpuBusy) {
            const busyDelta = busyTicks - this.prevGpuBusy.busy;
            const totalDelta = totalTicks - this.prevGpuBusy.total;
            load = totalDelta > 0 ? Math.min(100, Math.max(0, Math.round((busyDelta / totalDelta) * 100))) : 0;
          } else {
            load = Math.min(100, Math.max(0, Math.round((busyTicks / totalTicks) * 100)));
          }
          this.prevGpuBusy = { busy: busyTicks, total: totalTicks };
          return load;
        } else if (parts.length === 1 && !isNaN(parts[0])) {
          return Math.min(100, Math.max(0, parts[0]));
        }
      } catch {
        continue;
      }
    }

    try {
      const devfreqDirs = [
        "/sys/class/devfreq/gpufreq/gpu_loading",
        "/sys/module/ged/parameters/gpu_loading",
        "/sys/class/devfreq/3d00000.gpu/load",
        "/sys/class/devfreq/1c00000.gpu/load",
        "/sys/class/devfreq/soc:qcom,kgsl-3d0/load",
        "/sys/class/devfreq/13000000.gpu/load",
        "/sys/class/devfreq/mtk-gpu/load",
        "/sys/module/mali/parameters/mali_gpu_utilization",
        "/sys/class/misc/mali0/device/utilization",
        "/sys/devices/platform/13000000.mali/mali_gpu_utilization",
      ];
      for (const p of devfreqDirs) {
        try {
          const utilStr = await Deno.readTextFile(p);
          const parsed = parseInt(utilStr.trim(), 10);
          if (!isNaN(parsed) && parsed >= 0) {
            return Math.min(100, parsed);
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Suppress
    }

    const rc6Paths = [
      "/sys/class/drm/card1/gt/gt0/rc6_residency_ms",
      "/sys/class/drm/card0/gt/gt0/rc6_residency_ms",
      "/sys/class/drm/card1/power/rc6_residency_ms",
      "/sys/class/drm/card0/power/rc6_residency_ms",
      "/sys/class/drm/card2/gt/gt0/rc6_residency_ms",
      "/sys/class/drm/card2/power/rc6_residency_ms",
    ];

    let validRc6Path: string | null = null;
    let currentRc6: number | null = null;

    for (const p of rc6Paths) {
      try {
        const str = await Deno.readTextFile(p);
        const val = parseInt(str.trim(), 10);
        if (!isNaN(val) && val >= 0) {
          validRc6Path = p;
          currentRc6 = val;
          break;
        }
      } catch {
        continue;
      }
    }

    if (validRc6Path && currentRc6 !== null) {
      const now = performance.now();
      if (this.prevRc6 && this.prevRc6.rc6 >= 0) {
        const elapsedMs = now - this.prevRc6.time;
        const rcDelta = currentRc6 - this.prevRc6.rc6;
        if (elapsedMs > 0 && rcDelta >= 0 && rcDelta <= elapsedMs + 1000) {
          const idleRatio = Math.max(0, Math.min(1, rcDelta / elapsedMs));
          load = Math.min(100, Math.max(0, Math.round((1 - idleRatio) * 100)));
          this.prevRc6 = { rc6: currentRc6, time: now };
          return load;
        }
        this.prevRc6 = { rc6: currentRc6, time: now };
      } else {
        this.prevRc6 = { rc6: currentRc6, time: now };
      }
    }

    const busyPaths = [
      "/sys/class/drm/card0/device/gpu_busy_percent",
      "/sys/class/drm/card1/device/gpu_busy_percent",
      "/sys/class/drm/card0/gt/gt0/gpu_busy_percent",
      "/sys/class/drm/card1/gt/gt0/gpu_busy_percent",
      "/sys/class/drm/card1/gt3d_busy_100ms",
    ];
    for (const bp of busyPaths) {
      try {
        const busyStr = await Deno.readTextFile(bp);
        const val = parseInt(busyStr.trim(), 10);
        if (!isNaN(val) && val >= 0) {
          return Math.min(100, Math.max(0, val));
        }
      } catch {
        continue;
      }
    }

    return load;
  }

  private static async getBatteryPower(): Promise<number> {
    try {
      if (Deno.build.os === "windows") {
        const psScript = `
          $ErrorActionPreference = 'SilentlyContinue'
          $bs = Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1
          if ($bs) {
            $dRate = $bs.DischargeRate
            $cRate = $bs.ChargeRate
            if ($bs.Discharging -and $dRate -and $dRate -gt 0) {
              [math]::Round($dRate / 1000, 2)
            } elseif ($bs.Charging -and $cRate -and $cRate -gt 0) {
              [math]::Round($cRate / 1000, 2)
            } elseif ($dRate -and $dRate -gt 0) {
              [math]::Round($dRate / 1000, 2)
            } elseif ($cRate -and $cRate -gt 0) {
              [math]::Round($cRate / 1000, 2)
            } else { 0 }
          } else {
            $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($bat) {
              $rate = if ($bat.DischargeRate) { [math]::Abs($bat.DischargeRate) } else { 0 }
              if ($rate -gt 0) {
                if ($rate -gt 100000) { [math]::Round($rate / 1000000, 2) }
                else { [math]::Round($rate / 1000, 2) }
              } else { 0 }
            } else { -1 }
          }
        `;
        const cmd = new Deno.Command("powershell", {
          args: ["-NoProfile", "-Command", psScript],
        });
        const out = await cmd.output();
        if (out.success) {
          const val = parseFloat(new TextDecoder().decode(out.stdout).trim());
          if (!isNaN(val) && val >= 0) {
            return val;
          }
        }
      } else {
        try {
          const cmd = new Deno.Command("termux-battery-status");
          const out = await cmd.output();
          if (out.success) {
            const json = JSON.parse(new TextDecoder().decode(out.stdout).trim());
            if (json && typeof json.current === "number") {
              const currentVal = Math.abs(json.current);
              const currentA = currentVal > 100000
                ? currentVal / 1000000
                : currentVal > 100
                  ? currentVal / 1000
                  : currentVal;
              const watts = parseFloat((currentA * 3.85).toFixed(2));
              if (watts > 0.05) {
                return watts;
              } else if (json.status && json.status.toUpperCase() === "FULL") {
                return 0;
              }
            }
          }
        } catch {
          // Suppress
        }

        const batteryDirs = [
          "/sys/class/power_supply/BAT0",
          "/sys/class/power_supply/BAT1",
          "/sys/class/power_supply/battery",
          "/sys/class/power_supply/bms",
        ];

        for (const dir of batteryDirs) {
          try {
            let status = "";
            try {
              status = (await Deno.readTextFile(`${dir}/status`)).trim();
            } catch {
              // Ignore
            }

            try {
              const powerNowStr = await Deno.readTextFile(`${dir}/power_now`);
              const powerNowVal = Math.abs(parseInt(powerNowStr.trim(), 10));
              if (!isNaN(powerNowVal) && powerNowVal > 0) {
                const watts = powerNowVal > 100000 ? powerNowVal / 1000000 : powerNowVal / 1000;
                if (watts > 0.05) {
                  return parseFloat(watts.toFixed(2));
                }
              }
            } catch {
              // Continue
            }

            try {
              const currentStr = await Deno.readTextFile(`${dir}/current_now`);
              const voltageStr = await Deno.readTextFile(`${dir}/voltage_now`);
              const currentVal = Math.abs(parseInt(currentStr.trim(), 10));
              const voltageVal = parseInt(voltageStr.trim(), 10);
              if (!isNaN(currentVal) && currentVal > 0) {
                const currentA = currentVal > 100000 ? currentVal / 1000000 : currentVal / 1000;
                let voltageV = 3.85;
                if (!isNaN(voltageVal) && voltageVal > 0) {
                  voltageV = voltageVal > 1000000
                    ? voltageVal / 1000000
                    : voltageVal > 1000
                      ? voltageVal / 1000
                      : voltageVal;
                }
                const watts = parseFloat((currentA * voltageV).toFixed(2));
                if (watts > 0.05) {
                  return watts;
                }
              }
            } catch {
              // Continue
            }

            if (status.toLowerCase() === "full") {
              return 0;
            }
          } catch {
            continue;
          }
        }

        for (let i = 0; i <= 10; i++) {
          try {
            const nameStr = (await Deno.readTextFile(`/sys/class/hwmon/hwmon${i}/name`)).trim().toUpperCase();
            if (nameStr.startsWith("BAT") || nameStr.includes("BATTERY")) {
              for (const pName of ["power1_input", "power2_input"]) {
                try {
                  const valStr = await Deno.readTextFile(`/sys/class/hwmon/hwmon${i}/${pName}`);
                  const uW = Math.abs(parseInt(valStr.trim(), 10));
                  if (!isNaN(uW) && uW > 0) {
                    const watts = uW / 1000000;
                    if (watts > 0.05 && watts < 500) {
                      return parseFloat(watts.toFixed(2));
                    }
                  }
                } catch {
                  continue;
                }
              }
            }
          } catch {
            continue;
          }
        }
      }
    } catch (e) {
      Log.debug(this.TAG, "[BATTERY DEBUG] Read power exception:", e);
    }
    return -1;
  }

  private static async getDiskMetrics(): Promise<{ usedGb: number; totalGb: number }> {
    try {
      if (Deno.build.os === "windows") {
        const cmd = new Deno.Command("powershell", {
          args: [
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\") | Select-Object Size, FreeSpace | ConvertTo-Json",
          ],
        });
        const out = await cmd.output();
        if (out.success) {
          const parsed = JSON.parse(new TextDecoder().decode(out.stdout).trim());
          const totalGb = Math.round(parsed.Size / 1073741824);
          const freeGb = Math.round(parsed.FreeSpace / 1073741824);
          const usedGb = totalGb - freeGb;
          return { usedGb, totalGb };
        }
      } else {
        let targetMount = "/";
        try {
          const termuxHome = "/data/data/com.termux/files/home";
          const st = await Deno.stat(termuxHome);
          if (st.isDirectory) targetMount = termuxHome;
        } catch {
          targetMount = "/";
        }

        const cmd = new Deno.Command("df", { args: ["-k", targetMount] });
        const out = await cmd.output();
        const lines = new TextDecoder().decode(out.stdout).trim().split("\n");
        if (lines.length >= 2) {
          const cols = lines[lines.length - 1].split(/\s+/);
          const totalKb = parseInt(cols[1], 10);
          const usedKb = parseInt(cols[2], 10);
          if (!isNaN(totalKb) && !isNaN(usedKb)) {
            const usedGb = Math.round(usedKb / 1048576);
            const totalGb = Math.round(totalKb / 1048576);
            return { usedGb, totalGb };
          }
        }
      }
    } catch (e) {
      Log.debug(this.TAG, "[DISK DEBUG] Metrics collection failed:", e);
    }
    return { usedGb: -1, totalGb: -1 };
  }

  private static async getThermalMetrics(): Promise<number> {
    try {
      if (Deno.build.os === "windows") {
        const psScript = `
          $tzCounter = Get-Counter '\\Thermal Zone Information(*)\\Temperature' -ErrorAction SilentlyContinue
          if ($tzCounter) {
            $rawKelvin = ($tzCounter.CounterSamples | Where-Object { $_.CookedValue -gt 273 } | Measure-Object -Property CookedValue -Maximum).Maximum
            if ($rawKelvin) {
              return [math]::Round($rawKelvin - 273.15)
            }
          }
          $t2 = Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue
          if ($t2) {
            $maxT = ($t2 | Measure-Object -Property HighPrecisionTemperature -Maximum).Maximum
            if ($maxT -and $maxT -gt 27315) {
              return [math]::Round(($maxT - 27315) / 100)
            }
          }
          $t1 = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1 CurrentTemperature
          if ($t1 -and $t1.CurrentTemperature -gt 2732) {
            return [math]::Round(($t1.CurrentTemperature - 2732) / 10)
          }
          $t4 = Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction SilentlyContinue | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -like '*CPU Core*' } | Select-Object -First 1 Value
          if ($t4 -and $t4.Value -gt 0) {
            return [math]::Round($t4.Value)
          }
          return -1
        `;
        const cmd = new Deno.Command("powershell", {
          args: ["-NoProfile", "-Command", psScript],
        });
        const out = await cmd.output();
        if (out.success) {
          const val = parseInt(new TextDecoder().decode(out.stdout).trim(), 10);
          if (!isNaN(val) && val > 0) {
            return val;
          }
        }
      } else {
        try {
          const cmd = new Deno.Command("termux-battery-status");
          const out = await cmd.output();
          if (out.success) {
            const json = JSON.parse(new TextDecoder().decode(out.stdout).trim());
            if (json && typeof json.temperature === "number" && json.temperature > 0) {
              return Math.round(json.temperature);
            }
          }
        } catch {
          // Suppress
        }

        const zones: string[] = [];
        for (let i = 0; i <= 20; i++) zones.push(`/sys/class/thermal/thermal_zone${i}/temp`);
        zones.push("/sys/class/power_supply/battery/temp", "/sys/class/power_supply/battery/batt_temp");

        for (const zonePath of zones) {
          try {
            const tempText = await Deno.readTextFile(zonePath);
            const tempVal = parseInt(tempText.trim(), 10);
            if (!isNaN(tempVal) && tempVal > 0) {
              let c = tempVal;
              if (tempVal > 10000) c = Math.round(tempVal / 1000);
              else if (tempVal > 100) c = Math.round(tempVal / 10);
              if (c >= 5 && c <= 110) {
                return c;
              }
            }
          } catch {
            continue;
          }
        }
      }
    } catch (e) {
      Log.debug(this.TAG, "[TEMP DEBUG] Thermal query exception:", e);
    }
    return -1;
  }

  private static async getUptimeMs(): Promise<number> {
    try {
      if (Deno.build.os === "windows") {
        const cmd = new Deno.Command("powershell", {
          args: [
            "-NoProfile",
            "-Command",
            "[Math]::Floor((Get-Date).Subtract((Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalMilliseconds)",
          ],
        });
        const out = await cmd.output();
        if (out.success) {
          const ms = parseInt(new TextDecoder().decode(out.stdout).trim(), 10);
          if (!isNaN(ms) && ms > 0) {
            return ms;
          }
        }
      } else {
        try {
          if (typeof Deno.osUptime === "function") {
            const sec = Deno.osUptime();
            if (typeof sec === "number" && sec > 0) {
              return Math.floor(sec * 1000);
            }
          }
        } catch {
          // Suppress
        }

        try {
          const txt = await Deno.readTextFile("/proc/uptime");
          const seconds = parseFloat(txt.split(/\s+/)[0]);
          if (!isNaN(seconds) && seconds > 0) {
            return Math.floor(seconds * 1000);
          }
        } catch {
          try {
            const cmd = new Deno.Command("uptime");
            const out = await cmd.output();
            if (out.success) {
              const txt = new TextDecoder().decode(out.stdout);
              let totalSeconds = 0;
              const daysMatch = txt.match(/up\s+(\d+)\s+days?/i);
              if (daysMatch) totalSeconds += parseInt(daysMatch[1], 10) * 86400;
              const timeMatch = txt.match(/(\d+):(\d+)(?::(\d+))?/);
              if (timeMatch) {
                totalSeconds += parseInt(timeMatch[1], 10) * 3600 +
                  parseInt(timeMatch[2], 10) * 60 +
                  (timeMatch[3] ? parseInt(timeMatch[3], 10) : 0);
              } else {
                const minsMatch = txt.match(/up\s+.*?(\d+)\s+mins?/i);
                if (minsMatch) totalSeconds += parseInt(minsMatch[1], 10) * 60;
              }
              if (totalSeconds > 0) return totalSeconds * 1000;
            }
          } catch {
            // Suppress
          }
        }
      }
    } catch (e) {
      Log.debug(this.TAG, "[UPTIME DEBUG] Calculation error:", e);
    }
    return -1;
  }
}
