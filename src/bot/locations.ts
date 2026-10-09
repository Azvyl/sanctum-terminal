import { parse } from "node-html-parser";
import { Log } from "../logger.ts";
import { deserializeNuxtData } from "./parser.ts";
import { bmkgFetch, bmkgFetchText } from "./bmkg.ts";

export { bmkgFetch };

export interface LocationItem {
  name: string;
  code: string;
}

interface LocalLocationStore {
  provinces: LocationItem[];
  children: Record<string, LocationItem[]>;
}

export class LocationCacheService {
  private static TAG = "LocationCache";
  private static CACHE_FILE_PATH = "./locations_cache.json";
  private static localCache: LocalLocationStore = {
    provinces: [],
    children: {},
  };
  private static isCacheLoaded = false;

  private static async loadLocalCache(): Promise<void> {
    if (this.isCacheLoaded) return;
    try {
      const data = await Deno.readTextFile(this.CACHE_FILE_PATH);
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object") {
        this.localCache = {
          provinces: Array.isArray(parsed.provinces) ? parsed.provinces : [],
          children: typeof parsed.children === "object" && parsed.children !== null ? parsed.children : {},
        };
      }
      Log.info(this.TAG, "Loaded location cache from local file.");
    } catch {
      Log.info(this.TAG, "No existing local location cache file found. Initializing new cache store.");
    } finally {
      this.isCacheLoaded = true;
    }
  }

  private static async saveLocalCache(): Promise<void> {
    try {
      await Deno.writeTextFile(this.CACHE_FILE_PATH, JSON.stringify(this.localCache, null, 2));
      Log.debug(this.TAG, "Location cache saved to local JSON file.");
    } catch (e) {
      Log.error(this.TAG, "Failed saving location cache to local file:", e);
    }
  }

  static async scrapeBmkgLocations(parentCode?: string): Promise<LocationItem[]> {
    const url = parentCode
      ? `https://www.bmkg.go.id/cuaca/prakiraan-cuaca/${parentCode}`
      : `https://www.bmkg.go.id/cuaca/prakiraan-cuaca`;
    Log.info(this.TAG, `Scraping BMKG hierarchy from: ${url}`);
    try {
      const html = await bmkgFetchText(url);
      const root = parse(html);
      const items: LocationItem[] = [];
      const anchors = root.querySelectorAll("a");
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        const match = href.match(/\/cuaca\/prakiraan-cuaca\/([\d\.]+)$/);
        if (match) {
          const code = match[1];
          if (!parentCode) {
            if (code.includes(".")) continue;
          } else {
            if (!code.startsWith(parentCode + ".")) continue;
            const parentDots = parentCode.split(".").length;
            const codeDots = code.split(".").length;
            if (codeDots !== parentDots + 1) continue;
          }
          let name = a.text.trim();
          const p = a.querySelector("p");
          if (p) name = p.text.trim();
          if (name && name !== "Selengkapnya" && !items.some((i) => i.code === code)) {
            items.push({ name, code });
          }
        }
      }
      return items;
    } catch (e) {
      Log.error(this.TAG, "Error scraping BMKG location data:", e);
      return [];
    }
  }

  static async getProvinces(): Promise<LocationItem[]> {
    await this.loadLocalCache();
    if (this.localCache.provinces && this.localCache.provinces.length > 0) {
      return this.localCache.provinces;
    }
    const fetched = await this.scrapeBmkgLocations();
    if (fetched.length > 0) {
      this.localCache.provinces = fetched;
      await this.saveLocalCache();
    }
    return fetched;
  }

  static async getChildren(parentCode: string): Promise<LocationItem[]> {
    await this.loadLocalCache();
    if (this.localCache.children[parentCode] && this.localCache.children[parentCode].length > 0) {
      return this.localCache.children[parentCode];
    }
    const fetched = await this.scrapeBmkgLocations(parentCode);
    if (fetched.length > 0) {
      this.localCache.children[parentCode] = fetched;
      await this.saveLocalCache();
    }
    return fetched;
  }

  static async getAvailableDates(kelCode: string): Promise<string[]> {
    try {
      const url = `https://www.bmkg.go.id/cuaca/prakiraan-cuaca/${kelCode}`;
      const html = await bmkgFetchText(url);
      const root = parse(html);
      const scripts = root.querySelectorAll("script");
      const nuxtScript = scripts.find((s) => s.getAttribute("id") === "__NUXT_DATA__" || s.text.includes("__NUXT_DATA__"));
      if (!nuxtScript) return [];
      const rawText = nuxtScript.text.trim();
      const jsonStart = rawText.indexOf("[");
      const jsonEnd = rawText.lastIndexOf("]") + 1;
      const array = JSON.parse(rawText.slice(jsonStart, jsonEnd));
      const weatherRecords = deserializeNuxtData(array);
      const datesSet = new Set<string>();
      for (const rec of weatherRecords) {
        if (rec.local_datetime) {
          const dateOnly = rec.local_datetime.split(" ")[0] || rec.local_datetime.split("T")[0];
          if (dateOnly) datesSet.add(dateOnly);
        }
      }
      return Array.from(datesSet).sort();
    } catch (e) {
      Log.error(this.TAG, `Failed fetching available weather dates for ${kelCode}:`, e);
      return [];
    }
  }
}
