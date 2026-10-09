import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  ForumChannel,
  ThreadChannel,
} from "discord.js";
import { parse } from "node-html-parser";
import { get, onValue, ref, set, Unsubscribe } from "firebase/database";
import { DISCORD_CHANNELS, WEATHER_TAGS } from "../config.ts";
import { DB_PATHS, FirebaseManager } from "../firebase.ts";
import { Log } from "../logger.ts";

interface WeatherState {
  potensiEkstremThreadId?: string;
  potensiEkstremMessageId?: string;
  potensiEkstremLastHash?: string;
  peringatanDiniThreads: {
    [provinsiKode: string]: {
      threadId: string;
      messageId: string;
      lastHash: string;
      expiredAt?: number;
    };
  };
  gelombangTinggiThreadId?: string;
  gelombangTinggiMessageId?: string;
  gelombangTinggiLastHash?: string;
}

function safeFieldValue(value: string | undefined | null, maxLength = 1024, fallback = "Nihil / Sesuai Pengumuman"): string {
  if (!value || value.trim() === "") return fallback;
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength - 4) + "..." : trimmed;
}

function formatWilayahList(wilayah: string[], maxLength = 1000): string {
  if (!wilayah || wilayah.length === 0) return "Nihil / Sesuai Infografis";
  let result = "";
  let addedCount = 0;
  for (let i = 0; i < wilayah.length; i++) {
    const item = wilayah[i];
    const remaining = wilayah.length - 1 - i;
    const suffix = remaining > 0 ? `\n*...dan ${remaining} wilayah lainnya.*` : "";
    const potential = result ? `${result}\n${item}${suffix}` : `${item}${suffix}`;
    if (potential.length <= maxLength) {
      result = result ? `${result}\n${item}` : item;
      addedCount++;
    } else {
      result += `\n*...dan ${wilayah.length - addedCount} wilayah lainnya.*`;
      break;
    }
  }
  return result || "Nihil / Sesuai Infografis";
}

function createHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

import { bmkgFetchText } from "./bmkg.ts";

class BMKGCuacaParser {
  static async fetchHtml(url: string): Promise<string> {
    return await bmkgFetchText(url);
  }

  static parseCellWarnings(td: unknown): string[] {
    const alerts: string[] = [];
    if (!td) return alerts;
    // @ts-ignore node-html-parser cell query
    const text = td.text ? td.text.trim() : "";
    if (text && text !== " ") alerts.push(text);
    return alerts;
  }

  static async parsePotensiEkstrem() {
    try {
      const html = await this.fetchHtml("https://www.bmkg.go.id/cuaca/potensi-cuaca-ekstrem");
      const root = parse(html);
      const headers = root.querySelectorAll("table thead tr th");
      let tanggal = "Hari Ini s/d Lusa";
      let d1 = "Hari 1", d2 = "Hari 2", d3 = "Hari 3";
      if (headers.length >= 5) {
        d1 = headers[2].text.trim();
        d2 = headers[3].text.trim();
        d3 = headers[4].text.trim();
        tanggal = `${d1} s/d ${d3}`;
      }

      const wilayahList: string[] = [];
      const rows = root.querySelectorAll("table tbody tr");
      rows.forEach((row) => {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 5) {
          const provinsi = cells[1].text.trim();
          const a1 = cells[2].text.trim();
          const a2 = cells[3].text.trim();
          const a3 = cells[4].text.trim();
          const parts: string[] = [];
          if (a1 && a1 !== " ") parts.push(`${d1}: ${a1}`);
          if (a2 && a2 !== " ") parts.push(`${d2}: ${a2}`);
          if (a3 && a3 !== " ") parts.push(`${d3}: ${a3}`);
          if (parts.length > 0) wilayahList.push(`**${provinsi}** (${parts.join("; ")})`);
        }
      });

      const eventElem = root.querySelector("main p.text-gray-primary, .event-desc, p.deskripsi");
      const event = eventElem ? eventElem.text.trim() : "Potensi hujan lebat disertai kilat/petir dan angin kencang.";
      const rawText = `${tanggal}|${wilayahList.join(",")}|${event}`;
      return { tanggal, wilayah: wilayahList, event, rawText };
    } catch (e) {
      Log.error("BMKGParser", "Error parsing Potensi Ekstrem:", e);
      return null;
    }
  }

  static async parsePeringatanDini() {
    try {
      const html = await this.fetchHtml("https://www.bmkg.go.id/cuaca/peringatan-dini-cuaca");
      const root = parse(html);
      const waktuMulai = root.querySelector(".waktu-mulai")?.text.trim() || "Segera";
      const waktuBerakhir = root.querySelector(".waktu-berakhir")?.text.trim() || "Selesai";
      const event = root.querySelector(".peringatan-event")?.text.trim() || "Peringatan Dini Cuaca Aktif";

      const provinsiList: { nama: string; link: string; kode: string }[] = [];
      const rows = root.querySelectorAll("table tbody tr");
      rows.forEach((row) => {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 5) {
          const nama = cells[1].text.trim();
          const linkElem = cells[4].querySelector("a");
          if (linkElem) {
            const href = linkElem.getAttribute("href") || "";
            const match = href.match(/\/peringatan-dini-cuaca\/([a-zA-Z0-9\-]+)/);
            const kode = match ? match[1] : href.split("/").pop() || "";
            provinsiList.push({
              nama,
              link: href.startsWith("http") ? href : `https://www.bmkg.go.id${href}`,
              kode,
            });
          }
        }
      });

      const rawText = `${waktuMulai}|${waktuBerakhir}|${provinsiList.map((p) => p.kode).join(",")}`;
      return { waktuMulai, waktuBerakhir, event, provinsiList, rawText };
    } catch (e) {
      Log.error("BMKGParser", "Error parsing Peringatan Dini Induk:", e);
      return null;
    }
  }

  static async parsePeringatanDiniDetail(url: string, provinsiNama: string) {
    try {
      const html = await this.fetchHtml(url);
      const root = parse(html);
      const imgElem = root.querySelector("img[src*='infografis'], img[src*='peringatan'], main img");
      let gambarInfografis = imgElem?.getAttribute("src");
      if (gambarInfografis && !gambarInfografis.startsWith("http")) {
        gambarInfografis = `https://www.bmkg.go.id${gambarInfografis}`;
      }

      let deskripsi = "";
      const pElems = root.querySelectorAll("p");
      for (const p of pElems) {
        const txt = p.text.trim();
        if (txt.includes("Peringatan Dini") || txt.includes("UPDATE") || txt.includes("berpotensi")) {
          deskripsi = txt;
          break;
        }
      }
      if (!deskripsi) deskripsi = "Peringatan dini cuaca aktif untuk wilayah ini.";

      return {
        provinsi: provinsiNama,
        gambarInfografis,
        deskripsi,
        wilayahPeringatan: safeFieldValue(root.querySelector(".wilayah-terdampak")?.text, 1024, "Lihat detail di portal BMKG."),
        wilayahPotensiMeluas: safeFieldValue(root.querySelector(".wilayah-meluas")?.text, 1024, "Dapat meluas ke area sekitarnya."),
      };
    } catch {
      return null;
    }
  }

  static async parseGelombangTinggi() {
    try {
      const html = await this.fetchHtml("https://www.bmkg.go.id/cuaca/maritim/peringatan-gelombang-tinggi");
      const root = parse(html);
      const text = root.text || "";

      const parseCount = (cat: string) => {
        const m = text.match(new RegExp(`(\\d+)\\s+Perairan\\.\\s+${cat}`, "i"));
        return m ? parseInt(m[1], 10) : 0;
      };

      const ekstrem = parseCount("Ekstrem");
      const sangatTinggi = parseCount("Sangat Tinggi");
      const tinggi = parseCount("Tinggi");
      const sedang = parseCount("Sedang");

      let berlakuMulai = "Segera";
      let berlakuAkhir = "Hingga pemberitahuan selanjutnya";
      const bMatch = text.match(/Berlaku\s*:\s*([^.\n\r]+)/i);
      if (bMatch) {
        const parts = bMatch[1].split("-");
        if (parts.length >= 2) {
          berlakuMulai = parts[0].trim();
          berlakuAkhir = parts[1].trim();
        }
      }

      const rawText = `${ekstrem}|${sangatTinggi}|${tinggi}|${sedang}|${berlakuMulai}|${berlakuAkhir}`;
      return {
        ekstrem,
        sangatTinggi,
        tinggi,
        sedang,
        deskripsi: safeFieldValue(root.querySelector("p")?.text, 1024, "Peringatan keselamatan pelayaran maritim."),
        berlakuMulai,
        berlakuAkhir,
        rawText,
      };
    } catch {
      return null;
    }
  }
}

export class WeatherTrackerEngine {
  private TAG = "WeatherTracker";
  private state: WeatherState = { peringatanDiniThreads: {} };
  private lastSavedJson = "";
  private stateUnsubscribe: Unsubscribe | null = null;
  private isLoaded = false;

  constructor(private client: Client) {
    this.setupRealtimeSync();
  }

  private setupRealtimeSync() {
    const stateRef = ref(FirebaseManager.db, DB_PATHS.STATE_WEATHER_TRACKER);
    this.stateUnsubscribe = onValue(stateRef, (snap) => {
      const val = snap.val();
      Log.debug(this.TAG, `[DB RECV] onValue -> Path: "${DB_PATHS.STATE_WEATHER_TRACKER}"`, val);
      if (val) {
        this.state = { peringatanDiniThreads: {}, ...val };
        this.lastSavedJson = JSON.stringify(this.state);
      }
      this.isLoaded = true;
    });
  }

  async loadState() {
    if (this.isLoaded) return;
    try {
      Log.debug(this.TAG, `[DB SEND/GET REQUEST] Fetching initial Weather Tracker state -> Path: "${DB_PATHS.STATE_WEATHER_TRACKER}"`);
      const snap = await get(ref(FirebaseManager.db, DB_PATHS.STATE_WEATHER_TRACKER));
      const val = snap.val();
      Log.debug(this.TAG, `[DB RECV] get -> Path: "${DB_PATHS.STATE_WEATHER_TRACKER}"`, val);
      if (val) {
        this.state = { peringatanDiniThreads: {}, ...val };
        this.lastSavedJson = JSON.stringify(this.state);
      }
      this.isLoaded = true;
    } catch (e) {
      Log.error(this.TAG, "Failed loading weather tracker state from Firebase:", e);
    }
  }

  async saveState() {
    const currentJson = JSON.stringify(this.state);
    if (this.isLoaded && currentJson === this.lastSavedJson) {
      Log.debug(this.TAG, "Weather tracker state unmodified; skipping redundant network write.");
      return;
    }
    try {
      Log.debug(this.TAG, `[DB SEND] Saving Weather Tracker state (set) -> Path: "${DB_PATHS.STATE_WEATHER_TRACKER}"`, this.state);
      await set(ref(FirebaseManager.db, DB_PATHS.STATE_WEATHER_TRACKER), this.state);
      this.lastSavedJson = currentJson;
    } catch (e) {
      Log.error(this.TAG, "Failed saving weather tracker state to Firebase:", e);
    }
  }

  destroy() {
    if (this.stateUnsubscribe !== null) {
      try {
        this.stateUnsubscribe();
      } catch (_) {
        // Ignore
      }
      this.stateUnsubscribe = null;
    }
  }

  async runCheck() {
    Log.info(this.TAG, "Running periodic BMKG weather check...");
    try {
      const channel = await this.client.channels.fetch(DISCORD_CHANNELS.BMKG_WEATHER_NOTICE);
      if (!channel || !(channel instanceof ForumChannel)) return;

      await this.loadState();
      await this.processPotensiCuacaEkstrem(channel);
      await this.processPeringatanDini(channel);
      await this.processGelombangTinggi(channel);
      await this.saveState();
    } catch (err) {
      Log.error(this.TAG, "Weather tracking cycle error:", err);
    }
  }

  private async processPotensiCuacaEkstrem(forum: ForumChannel) {
    const data = await BMKGCuacaParser.parsePotensiEkstrem();
    if (!data) return;

    const currentHash = createHash(data.rawText);
    const tags = [WEATHER_TAGS.STATUS_AKTIF, WEATHER_TAGS.POTENSI_EKSTREM].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle("⛈️ Potensi Cuaca Ekstrem Nasional")
      .setDescription(`Informasi potensi cuaca ekstrem BMKG periode **${data.tanggal}**.`)
      .setColor(0xFFAA00)
      .addFields(
        { name: "📅 Tanggal Berlaku", value: data.tanggal, inline: false },
        { name: "⚠️ Potensi Fenomena", value: safeFieldValue(data.event), inline: false },
        { name: "📍 Wilayah Berpotensi Terdampak", value: formatWilayahList(data.wilayah), inline: false }
      )
      .setThumbnail("https://www.bmkg.go.id/images/icon.png")
      .setTimestamp();

    const components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("Cek Detail BMKG").setStyle(ButtonStyle.Link).setURL("https://www.bmkg.go.id/cuaca/potensi-cuaca-ekstrem")
      ),
    ];

    if (this.state.potensiEkstremThreadId && this.state.potensiEkstremMessageId) {
      try {
        const thread = (await forum.threads.fetch(this.state.potensiEkstremThreadId)) as ThreadChannel;
        if (thread && this.state.potensiEkstremLastHash !== currentHash) {
          const msg = await thread.messages.fetch(this.state.potensiEkstremMessageId);
          await msg.edit({ embeds: [embed], components });
          await thread.setAppliedTags(tags);
          this.state.potensiEkstremLastHash = currentHash;
        }
        return;
      } catch { /* recreate */ }
    }

    try {
      const thread = await forum.threads.create({
        name: `🌩️ Potensi Cuaca Ekstrem - ${data.tanggal.split(" s/d ")[0]}`,
        appliedTags: tags,
        message: { content: "📢 **Pemberitahuan Sistem:** BMKG merilis potensi cuaca ekstrem baru:", embeds: [embed], components },
      });
      const starter = await thread.fetchStarterMessage();
      this.state.potensiEkstremThreadId = thread.id;
      this.state.potensiEkstremMessageId = starter?.id;
      this.state.potensiEkstremLastHash = currentHash;
    } catch (e) {
      Log.error(this.TAG, "Failed creating Potensi Ekstrem thread:", e);
    }
  }

  private async processPeringatanDini(forum: ForumChannel) {
    const parentData = await BMKGCuacaParser.parsePeringatanDini();
    if (!parentData) return;

    const now = Date.now();
    for (const [kode, info] of Object.entries(this.state.peringatanDiniThreads || {})) {
      if (info.expiredAt && now > info.expiredAt) {
        try {
          const thread = (await forum.threads.fetch(info.threadId)) as ThreadChannel;
          if (thread) {
            await thread.setAppliedTags([WEATHER_TAGS.STATUS_PASIF, WEATHER_TAGS.PERINGATAN_DINI].filter(Boolean));
            await thread.setArchived(true);
          }
        } catch { /* Ignore */ }
        delete this.state.peringatanDiniThreads[kode];
      }
    }

    for (const prov of parentData.provinsiList) {
      const detail = await BMKGCuacaParser.parsePeringatanDiniDetail(prov.link, prov.nama);
      if (!detail) continue;

      const currentHash = createHash(`${detail.deskripsi}|${detail.wilayahPeringatan}`);
      const tags = [WEATHER_TAGS.STATUS_AKTIF, WEATHER_TAGS.PERINGATAN_DINI].filter(Boolean);

      const embed = new EmbedBuilder()
        .setTitle(`🚨 Peringatan Dini Cuaca - Prov. ${prov.nama}`)
        .setDescription(safeFieldValue(detail.deskripsi, 2048))
        .setColor(0xFF3333)
        .addFields(
          { name: "⏰ Mulai Berlaku", value: parentData.waktuMulai, inline: true },
          { name: "⏳ Perkiraan Berakhir", value: parentData.waktuBerakhir, inline: true },
          { name: "📍 Wilayah Peringatan Dini", value: detail.wilayahPeringatan, inline: false },
          { name: "📈 Potensi Meluas", value: detail.wilayahPotensiMeluas, inline: false }
        )
        .setTimestamp();

      if (detail.gambarInfografis) embed.setImage(detail.gambarInfografis);

      const existing = this.state.peringatanDiniThreads[prov.kode];
      if (existing) {
        try {
          const thread = (await forum.threads.fetch(existing.threadId)) as ThreadChannel;
          if (thread && existing.lastHash !== currentHash) {
            const msg = await thread.messages.fetch(existing.messageId);
            await msg.edit({ embeds: [embed] });
            this.state.peringatanDiniThreads[prov.kode].lastHash = currentHash;
            this.state.peringatanDiniThreads[prov.kode].expiredAt = Date.now() + 6 * 3600 * 1000;
          }
          continue;
        } catch { /* recreate */ }
      }

      try {
        const thread = await forum.threads.create({
          name: `⚠️ Peringatan Dini - ${prov.nama}`,
          appliedTags: tags,
          message: { content: `🚨 Peringatan Cuaca Aktif di **${prov.nama}**:`, embeds: [embed] },
        });
        const starter = await thread.fetchStarterMessage();
        this.state.peringatanDiniThreads[prov.kode] = {
          threadId: thread.id,
          messageId: starter?.id || "",
          lastHash: currentHash,
          expiredAt: Date.now() + 6 * 3600 * 1000,
        };
      } catch (e) { Log.error(this.TAG, `Failed creating thread for ${prov.nama}:`, e); }
    }
  }

  private async processGelombangTinggi(forum: ForumChannel) {
    const data = await BMKGCuacaParser.parseGelombangTinggi();
    if (!data) return;

    const currentHash = createHash(data.rawText);
    const tags = [WEATHER_TAGS.STATUS_AKTIF, WEATHER_TAGS.GELOMBANG_TINGGI].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle("🌊 Peringatan Dini Gelombang Tinggi Maritim")
      .setDescription(data.deskripsi)
      .setColor(0x3399FF)
      .addFields(
        { name: "⏰ Mulai Berlaku", value: data.berlakuMulai, inline: true },
        { name: "⏳ Berakhir", value: data.berlakuAkhir, inline: true },
        { name: "🔴 Ekstrem (> 6.0m)", value: `${data.ekstrem} Area`, inline: true },
        { name: "🟠 Sangat Tinggi (4.0 - 6.0m)", value: `${data.sangatTinggi} Area`, inline: true },
        { name: "🟡 Tinggi (2.5 - 4.0m)", value: `${data.tinggi} Area`, inline: true },
        { name: "🟢 Sedang (1.25 - 2.5m)", value: `${data.sedang} Area`, inline: true }
      )
      .setTimestamp();

    if (this.state.gelombangTinggiThreadId && this.state.gelombangTinggiMessageId) {
      try {
        const thread = (await forum.threads.fetch(this.state.gelombangTinggiThreadId)) as ThreadChannel;
        if (thread && this.state.gelombangTinggiLastHash !== currentHash) {
          const msg = await thread.messages.fetch(this.state.gelombangTinggiMessageId);
          await msg.edit({ embeds: [embed] });
          this.state.gelombangTinggiLastHash = currentHash;
        }
        return;
      } catch { /* recreate */ }
    }

    try {
      const thread = await forum.threads.create({
        name: "🌊 Peringatan Dini Gelombang Tinggi Nasional",
        appliedTags: tags,
        message: { content: "🌊 **Pemberitahuan Maritim BMKG:**", embeds: [embed] },
      });
      const starter = await thread.fetchStarterMessage();
      this.state.gelombangTinggiThreadId = thread.id;
      this.state.gelombangTinggiMessageId = starter?.id;
      this.state.gelombangTinggiLastHash = currentHash;
    } catch (e) { Log.error(this.TAG, "Failed creating Gelombang Tinggi thread:", e); }
  }
}
