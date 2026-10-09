import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
} from "discord.js";
import { parse } from "node-html-parser";
import { get, ref, set } from "firebase/database";
import { DISCORD_CHANNELS, DISCORD_ROLES, UPDATE_TAGS } from "../config.ts";
import { FirebaseManager, DB_PATHS } from "../firebase.ts";
import { Log } from "../logger.ts";
import { getArticleImage, getFirstParagraph, MinecraftArticle, parseArticle } from "./parser.ts";
import { t } from "../i18n/index.ts";
import { bmkgFetchText } from "./bmkg.ts";

export interface GempaRecord {
  threadId: string;
  messageId: string;
  createdAt: number;
  dataHash: string;
  title: string;
  magnitudo: string;
  kedalaman: string;
  koordinat: string;
  wilayah: string;
  momentTensor: string;
}

export interface TrackerState {
  lastBedrockVersion: string;
  lastJavaVersion: string;
  lastGempaId: string;
  recentGempas?: Record<string, GempaRecord>;
}

export const BMKG_MONTH_MAP: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  mei: "05",
  may: "05",
  jun: "06",
  jul: "07",
  agu: "08",
  aug: "08",
  sep: "09",
  okt: "10",
  oct: "10",
  nop: "11",
  nov: "11",
  des: "12",
  dec: "12",
};

export function parseBmkgTimeToId(waktuStr: string): string {
  const match = waktuStr.match(/(\d{1,2})[-/\s]+([A-Za-z]+)[-/\s]+(\d{2,4})\s+(\d{1,2})[:.](\d{1,2})[:.](\d{1,2})/);
  if (match) {
    const day = match[1].padStart(2, "0");
    const mStr = match[2].toLowerCase().slice(0, 3);
    const month = BMKG_MONTH_MAP[mStr];
    let year = match[3];
    if (year.length === 2) {
      year = `20${year}`;
    }
    const hour = match[4].padStart(2, "0");
    const min = match[5].padStart(2, "0");
    const sec = match[6].padStart(2, "0");
    if (month) {
      return `${year}${month}${day}${hour}${min}${sec}`;
    }
  }
  const digitsOnly = waktuStr.replace(/\D/g, "");
  return digitsOnly.length > 0 ? digitsOnly : Date.now().toString();
}

export function computeGempaHash(
  magnitudoStr: string,
  kedalaman: string,
  koordinat: string,
  wilayah: string,
  momentTensorText: string,
): string {
  const payload = `${magnitudoStr}|${kedalaman}|${koordinat}|${wilayah}|${momentTensorText}`;
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) + hash) ^ payload.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

export class UpdateTrackers {
  private static TAG = "Trackers";
  public static state: TrackerState = {
    lastBedrockVersion: "",
    lastJavaVersion: "",
    lastGempaId: "",
    recentGempas: {},
  };

  static async initializeLastStates() {
    Log.info(this.TAG, "Initializing tracker states (pre-flight check)...");
    try {
      const response = await fetch("https://feedback.minecraft.net/api/v2/help_center/en-us/articles.json");
      if (response.ok) {
        const data = await response.json();
        const articles: MinecraftArticle[] = data.articles || [];
        const latestBedrock = articles.find((a) => (a.section_id === 360001186971 || a.section_id === 360001185332) && !a.title.toLowerCase().includes("java"));
        if (latestBedrock) this.state.lastBedrockVersion = latestBedrock.title;
        const latestJava = articles.find((a) => (a.section_id === 360001186971 || a.section_id === 360002267532) && a.title.toLowerCase().includes("java"));
        if (latestJava) this.state.lastJavaVersion = latestJava.title;
      }

      try {
        const htmlText = await bmkgFetchText("https://www.bmkg.go.id/gempabumi/gempabumi-realtime");
        const root = parse(htmlText);
        const firstRow = root.querySelector("table tbody tr");
        if (firstRow) {
          const timeCell = firstRow.querySelectorAll("td")[1]?.text.trim().replace(/\s+/g, " ") || "";
          if (timeCell) {
            this.state.lastGempaId = parseBmkgTimeToId(timeCell);
          }
        }
      } catch (err) {
        Log.warn(this.TAG, "Initial BMKG gempa fetch warning:", err);
      }
      this.state.recentGempas = this.state.recentGempas || {};
      await this.saveStateToFirebase();
      Log.success(this.TAG, "Tracker states pre-flight initialization complete.");
    } catch (e) {
      Log.error(this.TAG, "Error in initializeLastStates:", e);
    }
  }

  static async loadStateFromFirebase() {
    try {
      Log.debug(this.TAG, `[DB SEND/GET REQUEST] Fetching tracker state -> Path: "${DB_PATHS.STATE_BOT_TRACKER}"`);
      const snap = await get(ref(FirebaseManager.db, DB_PATHS.STATE_BOT_TRACKER));
      const val = snap.val();
      Log.debug(this.TAG, `[DB RECV] get -> Path: "${DB_PATHS.STATE_BOT_TRACKER}"`, val);

      if (val) {
        this.state = {
          lastBedrockVersion: val.lastBedrockVersion || "",
          lastJavaVersion: val.lastJavaVersion || "",
          lastGempaId: val.lastGempaId || "",
          recentGempas: val.recentGempas || {},
        };
      } else {
        await this.initializeLastStates();
      }
    } catch (e) {
      Log.error(this.TAG, "Error loading tracker state from Firebase:", e);
    }
  }

  static async saveStateToFirebase() {
    try {
      Log.debug(this.TAG, `[DB SEND] Saving tracker state (set) -> Path: "${DB_PATHS.STATE_BOT_TRACKER}"`, this.state);
      await set(ref(FirebaseManager.db, DB_PATHS.STATE_BOT_TRACKER), this.state);
    } catch (e) {
      Log.error(this.TAG, "Error saving tracker state to Firebase:", e);
    }
  }

  static async trackMinecraftBedrock(client: Client) {
    try {
      const response = await fetch("https://feedback.minecraft.net/api/v2/help_center/en-us/articles.json");
      if (!response.ok) return;
      const data = await response.json();
      const articles: MinecraftArticle[] = data.articles || [];
      const bedrockArticles = articles.filter(
        (a) => (a.section_id === 360001186971 || a.section_id === 360001185332) && !a.title.toLowerCase().includes("java")
      );
      if (bedrockArticles.length === 0) return;

      const latest = bedrockArticles[0];
      if (latest.title !== this.state.lastBedrockVersion) {
        Log.info(this.TAG, `New Bedrock Release Detected: ${latest.title}`);
        const channel = await client.channels.fetch(DISCORD_CHANNELS.MINECRAFT_UPDATE);
        if (channel && channel.type === ChannelType.GuildForum) {
          const parsedInfo = parseArticle(latest);
          if (parsedInfo && parsedInfo.type === "bedrock") {
            const paragraph = getFirstParagraph(latest.body || "");
            const embed = new EmbedBuilder()
              .setTitle(latest.title)
              .setURL(`https://feedback.minecraft.net/hc/en-us/articles/${latest.id}`)
              .setDescription(`### ${t("trackers.bedrock_title")}\n${paragraph ? `*"${paragraph}"*\n\n` : ""}${t("trackers.bedrock_desc")}`)
              .addFields(
                { name: t("trackers.update_type"), value: parsedInfo.updateType, inline: true },
                { name: t("trackers.date_updated"), value: `<t:${Math.floor(new Date(latest.updated_at).getTime() / 1000)}:F>`, inline: true }
              )
              .setColor(parsedInfo.tagId === UPDATE_TAGS.BEDROCK_PREVIEW ? 0xFFCC00 : (parsedInfo.tagId === UPDATE_TAGS.BEDROCK_HOTFIX ? 0xDA2F47 : 0x46FF27));

            const img = getArticleImage(latest.body || "");
            if (img) {
              embed.setImage(img);
            }

            await channel.threads.create({
              name: parsedInfo.threadName,
              message: {
                content: t("trackers.bedrock_ping_msg", { role: DISCORD_ROLES.BEDROCK_PING }),
                embeds: [embed],
                components: [
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setLabel(t("trackers.read_changelog"))
                      .setStyle(ButtonStyle.Link)
                      .setURL(`https://feedback.minecraft.net/hc/en-us/articles/${latest.id}`)
                  ),
                ],
              },
              appliedTags: [parsedInfo.tagId],
            });
          }
        }
        this.state.lastBedrockVersion = latest.title;
        await this.saveStateToFirebase();
      }
    } catch (e) {
      Log.error(this.TAG, "Bedrock tracking exception:", e);
    }
  }

  static async trackMinecraftJava(client: Client) {
    try {
      const response = await fetch("https://feedback.minecraft.net/api/v2/help_center/en-us/articles.json");
      if (!response.ok) return;
      const data = await response.json();
      const articles: MinecraftArticle[] = data.articles || [];
      const javaArticles = articles.filter(
        (a) => (a.section_id === 360001186971 || a.section_id === 360002267532) && a.title.toLowerCase().includes("java")
      );
      if (javaArticles.length === 0) return;

      const latest = javaArticles[0];
      if (latest.title !== this.state.lastJavaVersion) {
        Log.info(this.TAG, `New Java Release Detected: ${latest.title}`);
        const channel = await client.channels.fetch(DISCORD_CHANNELS.MINECRAFT_UPDATE);
        if (channel && channel.type === ChannelType.GuildForum) {
          const parsedInfo = parseArticle(latest);
          if (parsedInfo && parsedInfo.type === "java") {
            const paragraph = getFirstParagraph(latest.body || "");
            const embed = new EmbedBuilder()
              .setTitle(latest.title)
              .setURL(`https://feedback.minecraft.net/hc/en-us/articles/${latest.id}`)
              .setDescription(`### ${t("trackers.java_title")}\n${paragraph ? `*"${paragraph}"*\n\n` : ""}${t("trackers.java_desc")}`)
              .setColor(0x46FF27)
              .addFields(
                { name: t("trackers.update_type"), value: parsedInfo.updateType, inline: true },
                { name: t("trackers.date_updated"), value: `<t:${Math.floor(new Date(latest.updated_at).getTime() / 1000)}:F>`, inline: true }
              );

            const img = getArticleImage(latest.body || "");
            if (img) {
              embed.setImage(img);
            }

            await channel.threads.create({
              name: parsedInfo.threadName,
              message: {
                content: t("trackers.java_ping_msg", { role: DISCORD_ROLES.JAVA_PING }),
                embeds: [embed],
                components: [
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setLabel(t("trackers.read_changelog"))
                      .setStyle(ButtonStyle.Link)
                      .setURL(`https://feedback.minecraft.net/hc/en-us/articles/${latest.id}`)
                  ),
                ],
              },
              appliedTags: [parsedInfo.tagId],
            });
          }
        }
        this.state.lastJavaVersion = latest.title;
        await this.saveStateToFirebase();
      }
    } catch (e) { Log.error(this.TAG, "Java tracking exception:", e); }
  }

  static async trackGempaBMKG(client: Client) {
    try {
      const htmlText = await bmkgFetchText("https://www.bmkg.go.id/gempabumi/gempabumi-realtime");
      const root = parse(htmlText);
      const firstRow = root.querySelector("table tbody tr");
      if (!firstRow) return;

      const cells = firstRow.querySelectorAll("td");
      if (cells.length < 6) return;

      const waktu = cells[1].text.trim().replace(/\s+/g, " ");
      const magnitudoStr = cells[2].text.trim();
      const kedalaman = cells[3].text.trim();
      const koordinat = cells[4].text.trim();
      const wilayah = cells[5].text.trim();
      const momentTensorText = cells[6]?.text.trim() || "-";

      const gempaId = parseBmkgTimeToId(waktu);
      const currentHash = computeGempaHash(magnitudoStr, kedalaman, koordinat, wilayah, momentTensorText);
      const threadTitle = `(${magnitudoStr} SR) - ${wilayah.slice(0, 40)}`;

      if (!this.state.recentGempas) {
        this.state.recentGempas = {};
      }

      const now = Date.now();
      let cacheCleaned = false;
      for (const [id, record] of Object.entries(this.state.recentGempas)) {
        if (now - record.createdAt > 30 * 60 * 1000) {
          delete this.state.recentGempas[id];
          cacheCleaned = true;
        }
      }

      const existingRecord = this.state.recentGempas[gempaId];

      if (!existingRecord) {
        Log.info(this.TAG, `New Earthquake Detected: M ${magnitudoStr} - ${wilayah} (ID: ${gempaId})`);
        const channel = await client.channels.fetch(DISCORD_CHANNELS.BMKG_EARTHQUAKE);
        if (channel && channel.type === ChannelType.GuildForum) {
          const magnitudo = parseFloat(magnitudoStr.replace(",", "."));
          const color = magnitudo >= 5.0 ? 0xDA2F47 : 0xFFCC00;
          const embed = new EmbedBuilder()
            .setTitle(`⚠ ${t("trackers.gempa_title", { magnitude: magnitudoStr })}`)
            .setDescription(t("trackers.gempa_desc"))
            .addFields(
              { name: `📍 ${t("trackers.region")}`, value: wilayah, inline: false },
              { name: `⏰ ${t("trackers.event_time")}`, value: waktu, inline: true },
              { name: `💥 ${t("trackers.magnitude")}`, value: `${magnitudoStr} SR`, inline: true },
              { name: `🌊 ${t("trackers.depth")}`, value: kedalaman, inline: true },
              { name: `🗺️ ${t("trackers.coordinates")}`, value: koordinat, inline: true },
              { name: `📐 ${t("trackers.moment_tensor")}`, value: momentTensorText, inline: true },
            )
            .setColor(color)
            .setThumbnail("https://www.bmkg.go.id/images/icon.png")
            .setTimestamp();

          const thread = await channel.threads.create({
            name: threadTitle,
            message: {
              content: `🚨 ${t("trackers.gempa_ping_msg", { role: DISCORD_ROLES.GEMPA_PING })}`,
              embeds: [embed],
              components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setLabel(t("trackers.check_map"))
                    .setStyle(ButtonStyle.Link)
                    .setURL("https://www.bmkg.go.id/gempabumi/gempabumi-realtime"),
                ),
              ],
            },
          });

          const starterMessage = await thread.fetchStarterMessage();
          const messageId = starterMessage?.id || thread.id;

          this.state.recentGempas[gempaId] = {
            threadId: thread.id,
            messageId,
            createdAt: Date.now(),
            dataHash: currentHash,
            title: threadTitle,
            magnitudo: magnitudoStr,
            kedalaman,
            koordinat,
            wilayah,
            momentTensor: momentTensorText,
          };
          this.state.lastGempaId = gempaId;
          await this.saveStateToFirebase();
        }
      } else if (existingRecord.dataHash !== currentHash) {
        Log.info(this.TAG, `Earthquake Parameter Update Detected: ID ${gempaId} (M ${magnitudoStr} - ${wilayah})`);
        const channel = await client.channels.fetch(existingRecord.threadId);
        if (channel && channel.isThread()) {
          const thread = channel;
          let starterMsg = null;
          try {
            starterMsg = await thread.messages.fetch(existingRecord.messageId);
          } catch {
            starterMsg = await thread.fetchStarterMessage();
          }

          if (existingRecord.title !== threadTitle && thread.name !== threadTitle) {
            try {
              await thread.setName(threadTitle);
            } catch (nameErr) {
              Log.warn(this.TAG, "Failed to update earthquake thread name:", nameErr);
            }
          }
          existingRecord.title = threadTitle;

          const magnitudo = parseFloat(magnitudoStr.replace(",", "."));
          const color = magnitudo >= 5.0 ? 0xDA2F47 : 0xFFCC00;
          const embed = new EmbedBuilder()
            .setTitle(`⚠ ${t("trackers.gempa_title", { magnitude: magnitudoStr })}`)
            .setDescription(t("trackers.gempa_desc"))
            .addFields(
              { name: `📍 ${t("trackers.region")}`, value: wilayah, inline: false },
              { name: `⏰ ${t("trackers.event_time")}`, value: waktu, inline: true },
              { name: `💥 ${t("trackers.magnitude")}`, value: `${magnitudoStr} SR`, inline: true },
              { name: `🌊 ${t("trackers.depth")}`, value: kedalaman, inline: true },
              { name: `🗺️ ${t("trackers.coordinates")}`, value: koordinat, inline: true },
              { name: `📐 ${t("trackers.moment_tensor")}`, value: momentTensorText, inline: true },
            )
            .setColor(color)
            .setThumbnail("https://www.bmkg.go.id/images/icon.png")
            .setTimestamp();

          if (starterMsg) {
            await starterMsg.edit({ embeds: [embed] });

            const diffs: string[] = [];
            if (existingRecord.magnitudo !== magnitudoStr) {
              diffs.push(`${t("trackers.magnitude")}: **${existingRecord.magnitudo}** ➔ **${magnitudoStr} SR**`);
            }
            if (existingRecord.kedalaman !== kedalaman) {
              diffs.push(`${t("trackers.depth")}: **${existingRecord.kedalaman}** ➔ **${kedalaman}**`);
            }
            if (existingRecord.koordinat !== koordinat) {
              diffs.push(`${t("trackers.coordinates")}: **${existingRecord.koordinat}** ➔ **${koordinat}**`);
            }
            if (existingRecord.wilayah !== wilayah) {
              diffs.push(`${t("trackers.region")}: **${existingRecord.wilayah}** ➔ **${wilayah}**`);
            }
            if (existingRecord.momentTensor !== momentTensorText) {
              diffs.push(`${t("trackers.moment_tensor")}: **${existingRecord.momentTensor}** ➔ **${momentTensorText}**`);
            }

            const diffSummary = diffs.length > 0
              ? diffs.join("\n")
              : "Parameter data gempabumi telah diperbarui oleh BMKG.";

            const replyContent = `🔄 **Pembaruan Parameter Gempabumi BMKG**\n${diffSummary}`;

            await starterMsg.reply({
              content: replyContent,
              allowedMentions: { repliedUser: false },
            });
          }

          existingRecord.dataHash = currentHash;
          existingRecord.magnitudo = magnitudoStr;
          existingRecord.kedalaman = kedalaman;
          existingRecord.koordinat = koordinat;
          existingRecord.wilayah = wilayah;
          existingRecord.momentTensor = momentTensorText;

          this.state.lastGempaId = gempaId;
          await this.saveStateToFirebase();
        }
      } else {
        if (cacheCleaned) {
          await this.saveStateToFirebase();
        }
      }
    } catch (e) { Log.error(this.TAG, "Gempa tracking exception:", e); }
  }
}
