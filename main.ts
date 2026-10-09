import { ConfigManager } from "./src/config.ts";
import { Log } from "./src/logger.ts";
import { DB_PATHS, FirebaseManager } from "./src/firebase.ts";
import { SystemTelemetry } from "./src/telemetry.ts";
import { ServiceElectionCoordinator } from "./src/watchdog.ts";
import { TerminalCli } from "./src/cli.ts";
import { ref, serverTimestamp, update } from "firebase/database";

if (import.meta.main) {
  Log.banner(ConfigManager.NODE_ID, ConfigManager.NODE_NAME);

  try {
    await FirebaseManager.initialize();
    await SystemTelemetry.startReporting();

    TerminalCli.start();

    Log.info(
      "SYSTEM",
      `Starting unified ServiceElectionCoordinator for node [${ConfigManager.NODE_ID}] (${ConfigManager.NODE_NAME})...`,
    );
    await ServiceElectionCoordinator.start();

    let isCleaningUp = false;
    const cleanup = async (sig: string) => {
      if (isCleaningUp) return;
      isCleaningUp = true;
      Log.warn("SYSTEM", `Signal ${sig} received. Performing graceful shutdown...`);

      const path = `${DB_PATHS.NODES}/${ConfigManager.NODE_ID}`;
      Log.debug("SYSTEM", `[DB SEND] Modifying database node active status (update) -> Path: "${path}"`);

      const performCleanup = async () => {
        try {
          await ServiceElectionCoordinator.stop();
          FirebaseManager.stopNodePresence();

          const updatePayload: Record<string, unknown> = {
            is_active: false,
            last_seen: serverTimestamp(),
          };

          await update(ref(FirebaseManager.db, path), updatePayload);
          Log.success("SYSTEM", "Node successfully marked offline in Firebase RTDB.");
        } catch (err) {
          Log.error("SYSTEM", "Failed to update offline status on exit:", err);
        }
      };

      const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 3000));
      await Promise.race([performCleanup(), timeoutPromise]);
      Deno.exit(0);
    };

    Deno.addSignalListener("SIGINT", () => cleanup("SIGINT"));
    Deno.addSignalListener("SIGTERM", () => cleanup("SIGTERM"));
  } catch (err) {
    Log.error("SYSTEM", "Fatal exception at application launch:", err);
    Deno.exit(1);
  }
}
