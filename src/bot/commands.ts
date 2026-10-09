import {
  type AutocompleteInteraction,
  type CommandInteraction,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { parse } from "node-html-parser";
import { ConfigManager } from "../config.ts";
import { Log } from "../logger.ts";
import { LocationCacheService } from "./locations.ts";
import { deserializeNuxtData } from "./parser.ts";
import { t } from "../i18n/index.ts";
import { BmkgHttpError, BmkgWafError, bmkgFetchText } from "./bmkg.ts";
import { buildRakNetEmbed, pingBedrockRakNet } from "./raknet.ts";
import { buildNetherNetEmbed, pingNetherNet } from "./nethernet.ts";
import { buildJavaEmbed, pingJava } from "./java.ts";
import { parseHostAndPort } from "./address.ts";
import { SsrfBlockedError } from "./ssrf.ts";

export const commandsMetadata = [
  new SlashCommandBuilder()
    .setName("mcping")
    .setDescription(t("commands.mcping_desc"))
    .addStringOption((option) =>
      option
        .setName("ip")
        .setDescription(t("commands.mcping_ip_desc"))
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("port")
        .setDescription(t("commands.mcping_port_desc"))
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("protocol")
        .setDescription(t("commands.mcping_protocol_desc"))
        .setRequired(false)
        .addChoices(
          { name: "Bedrock (RakNet UDP)", value: "bedrock_raknet" },
          { name: "Bedrock (NetherNet WebRTC)", value: "bedrock_nethernet" },
          { name: "Java Edition", value: "java" },
        )
    ),
  new SlashCommandBuilder()
    .setName("cuaca")
    .setDescription(t("commands.cuaca_desc"))
    .addStringOption((option) =>
      option
        .setName("provinsi")
        .setDescription(t("commands.cuaca_provinsi_desc"))
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("kab_kota")
        .setDescription(t("commands.cuaca_kab_kota_desc"))
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("kecamatan")
        .setDescription(t("commands.cuaca_kecamatan_desc"))
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("kelurahan_desa")
        .setDescription(t("commands.cuaca_kelurahan_desa_desc"))
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("tanggal")
        .setDescription(t("commands.cuaca_tanggal_desc"))
        .setRequired(false)
        .setAutocomplete(true)
    ),
];

export async function deployCommands() {
  if (!ConfigManager.DISCORD_BOT_TOKEN || !ConfigManager.DISCORD_BOT_APPLICATION_ID) return;
  const rest = new REST({ version: "10" }).setToken(ConfigManager.DISCORD_BOT_TOKEN);
  try {
    Log.info("Commands", "Deploying global Discord slash commands...");
    await rest.put(
      Routes.applicationCommands(ConfigManager.DISCORD_BOT_APPLICATION_ID),
      { body: commandsMetadata.map((cmd) => cmd.toJSON()) },
    );
    Log.success("Commands", "Slash commands registered successfully.");
  } catch (err) {
    Log.error("Commands", "Failed deploying slash commands:", err);
  }
}

export async function handleAutocomplete(interaction: AutocompleteInteraction) {
  if (interaction.commandName === "cuaca") {
    const focusedOption = interaction.options.getFocused(true);
    const val = focusedOption.value.toLowerCase();
    try {
      if (focusedOption.name === "provinsi") {
        const provs = await LocationCacheService.getProvinces();
        const filtered = provs.filter((p) => p.name.toLowerCase().includes(val)).slice(0, 25);
        await interaction.respond(filtered.map((p) => ({ name: p.name, value: p.code })));
      } else if (focusedOption.name === "kab_kota") {
        const provCode = interaction.options.getString("provinsi");
        if (!provCode) return await interaction.respond([]);
        const cities = await LocationCacheService.getChildren(provCode);
        const filtered = cities.filter((c) => c.name.toLowerCase().includes(val)).slice(0, 25);
        await interaction.respond(filtered.map((c) => ({ name: c.name, value: c.code })));
      } else if (focusedOption.name === "kecamatan") {
        const kabCode = interaction.options.getString("kab_kota");
        if (!kabCode) return await interaction.respond([]);
        const districts = await LocationCacheService.getChildren(kabCode);
        const filtered = districts.filter((d) => d.name.toLowerCase().includes(val)).slice(0, 25);
        await interaction.respond(filtered.map((d) => ({ name: d.name, value: d.code })));
      } else if (focusedOption.name === "kelurahan_desa") {
        const kecCode = interaction.options.getString("kecamatan");
        if (!kecCode) return await interaction.respond([]);
        const villages = await LocationCacheService.getChildren(kecCode);
        const filtered = villages.filter((v) => v.name.toLowerCase().includes(val)).slice(0, 25);
        await interaction.respond(filtered.map((v) => ({ name: v.name, value: v.code })));
      } else if (focusedOption.name === "tanggal") {
        const kelCode = interaction.options.getString("kelurahan_desa");
        const currentOptionName = t("commands.cuaca_saat_ini");
        if (!kelCode) return await interaction.respond([{ name: currentOptionName, value: "Saat Ini" }]);
        const dates = await LocationCacheService.getAvailableDates(kelCode);
        const options = [
          { name: currentOptionName, value: "Saat Ini" },
          ...dates.map((d) => ({ name: d, value: d })),
        ];
        const filtered = options.filter((d) => d.name.toLowerCase().includes(val)).slice(0, 25);
        await interaction.respond(filtered);
      }
    } catch (err) {
      Log.error("Commands", "Autocomplete error:", err);
    }
  }
}

export async function handleCommand(interaction: CommandInteraction) {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, options } = interaction;

  if (commandName === "mcping") {
    const protocol = options.getString("protocol") || "bedrock_raknet";
    const ip = options.getString("ip");
    const port = options.getInteger("port") ?? undefined;
    if (!ip || !ip.trim()) {
      await interaction.reply({
        content: t("mcping.validation_error_ip", { protocol }),
        ephemeral: true,
      });
      return;
    }

    const { host: parsedHost, port: extractedPort } = parseHostAndPort(ip);
    if (!parsedHost) {
      await interaction.reply({
        content: t("mcping.validation_error_ip", { protocol }),
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    const explicitPort = port ?? extractedPort;

    if (protocol === "bedrock_raknet") {
      const targetPort = explicitPort ?? 19132;
      const targetHost = parsedHost;
      try {
        const metrics = await pingBedrockRakNet(targetHost, targetPort);
        const embed = buildRakNetEmbed(targetHost, targetPort, metrics);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          await interaction.editReply({
            content: t("mcping.ssrf_blocked", { target: `${targetHost}:${targetPort}` }),
          });
          return;
        }
        Log.warn("Commands", `RakNet ping probe failed for ${targetHost}:${targetPort}:`, err);
        await interaction.editReply({
          content: t("mcping.server_offline", { target: `${targetHost}:${targetPort}` }),
        });
      }
      return;
    }

    if (protocol === "bedrock_nethernet") {
      const targetPort = explicitPort ?? 19132;
      const targetHost = parsedHost;
      try {
        const metrics = await pingNetherNet(targetHost, targetPort);
        const embed = buildNetherNetEmbed(metrics);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          await interaction.editReply({
            content: t("mcping.ssrf_blocked", { target: `${targetHost}:${targetPort}` }),
          });
          return;
        }
        Log.warn("Commands", `NetherNet ping probe failed for ${targetHost}:${targetPort}:`, err);
        await interaction.editReply({
          content: t("mcping.server_offline", { target: `${targetHost}:${targetPort}` }),
        });
      }
      return;
    }

    if (protocol === "java") {
      const targetHost = parsedHost;
      const targetPort = explicitPort;
      const targetDisplay = targetPort !== undefined ? `${targetHost}:${targetPort}` : targetHost;
      try {
        const metrics = await pingJava(targetHost, targetPort);
        const { embed, attachment } = buildJavaEmbed(metrics);
        if (attachment) {
          await interaction.editReply({ embeds: [embed], files: [attachment] });
        } else {
          await interaction.editReply({ embeds: [embed] });
        }
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          await interaction.editReply({
            content: t("mcping.ssrf_blocked", { target: targetDisplay }),
          });
          return;
        }
        Log.warn("Commands", `Java server ping error for ${targetDisplay}:`, err);
        await interaction.editReply({
          content: t("mcping.server_offline", { target: targetDisplay }),
        });
      }
      return;
    }
  }

  if (commandName === "cuaca") {
    await interaction.deferReply();
    const provCode = options.getString("provinsi", true);
    const kabCode = options.getString("kab_kota");
    const kecCode = options.getString("kecamatan");
    const kelCode = options.getString("kelurahan_desa");
    const tanggalSelected = options.getString("tanggal");

    let targetCode = provCode;
    let level = "provinsi";
    if (kabCode) {
      targetCode = kabCode;
      level = "kab_kota";
    }
    if (kecCode) {
      targetCode = kecCode;
      level = "kecamatan";
    }
    if (kelCode) {
      targetCode = kelCode;
      level = "kelurahan_desa";
    }

    try {
      const url = `https://www.bmkg.go.id/cuaca/prakiraan-cuaca/${targetCode}`;
      const html = await bmkgFetchText(url);
      const root = parse(html);

      if (level !== "kelurahan_desa") {
        const embed = new EmbedBuilder()
          .setTitle(t("weather.bmkg_title"))
          .setDescription(t("weather.sub_regions_desc"))
          .setColor(0x00A1FF);

        const tableRows = root.querySelectorAll("table tbody tr");
        let count = 0;
        for (const row of tableRows) {
          if (count >= 24) break;
          const link = row.querySelector("td a, td.relative a");
          if (!link) continue;
          const childName = link.text.trim();
          const cells = row.querySelectorAll("td");
          if (cells.length >= 2) {
            const h1 = cells[1]?.querySelector("p.font-medium")?.text.trim() || "-";
            const t1 = cells[1]?.querySelector("p.font-bold")?.text.trim() || "-";
            const valText = `${t("weather.weather_label")}: **${h1}**\n${t("weather.temp_label")}: **${t1}**`;
            embed.addFields({ name: childName, value: valText, inline: true });
            count++;
          }
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      const scripts = root.querySelectorAll("script");
      const nuxtDataScript = scripts.find(
        (s) => s.getAttribute("id") === "__NUXT_DATA__" || s.text.includes("__NUXT_DATA__"),
      );
      if (!nuxtDataScript) {
        await interaction.editReply({ content: t("weather.parse_failed") });
        return;
      }

      const nuxtDataText = nuxtDataScript.text.trim();
      const jsonStart = nuxtDataText.indexOf("[");
      const jsonEnd = nuxtDataText.lastIndexOf("]") + 1;
      const nuxtDataArray = JSON.parse(nuxtDataText.slice(jsonStart, jsonEnd));
      const weatherRecords = deserializeNuxtData(nuxtDataArray);

      if (weatherRecords.length === 0) {
        await interaction.editReply({ content: t("weather.no_active_data") });
        return;
      }

      const infoRecord = weatherRecords[0];
      const updateTime = infoRecord.analysis_local_datetime || infoRecord.analysis_date || "Terbaru";
      const embedDetail = new EmbedBuilder()
        .setTitle(t("weather.detail_title"))
        .setColor(0x00A1FF)
        .setFooter({ text: t("weather.source_footer", { time: updateTime }) });

      const isSaatIni = !tanggalSelected || tanggalSelected === "Saat Ini";
      if (isSaatIni) {
        const nowMs = Date.now();
        let closestRec = weatherRecords[0];
        let minDiff = Infinity;
        for (const rec of weatherRecords) {
          if (rec.local_datetime) {
            const recTime = new Date(rec.local_datetime.replace(" ", "T")).getTime();
            const diff = Math.abs(recTime - nowMs);
            if (diff < minDiff) {
              minDiff = diff;
              closestRec = rec;
            }
          }
        }
        embedDetail.setDescription(
          `### 📌 ${t("weather.current_conditions")}\n` +
          `• ${t("weather.weather_label")}: **${closestRec.weather_desc || "-"}**\n` +
          `• ${t("weather.temp_label")}: **${closestRec.t || "-"} °C**\n` +
          `• ${t("weather.humidity_label")}: **${closestRec.hu || "-"}%**\n` +
          `• ${t("weather.wind_speed_label")}: **${closestRec.ws || "-"} km/jam**\n` +
          `• ${t("weather.wind_direction_label")}: **${closestRec.wd || "-"}**\n` +
          `• ${t("weather.visibility_label")}: **${closestRec.vs_text || "-"}**`,
        );

        const currentIndex = weatherRecords.indexOf(closestRec);
        const futureRecs = weatherRecords.slice(currentIndex + 1, currentIndex + 5);

        if (futureRecs.length > 0) {
          embedDetail.addFields({ name: `⏳ ${t("weather.hourly_forecast")}`, value: " " });
          for (const f of futureRecs) {
            const timeStr = f.local_datetime
              ? f.local_datetime.split(" ")[1]?.slice(0, 5) || f.local_datetime
              : "N/A";
            embedDetail.addFields({
              name: `🕒 ${t("weather.hour_label", { time: timeStr })}`,
              value: `• ${t("weather.weather_label")}: **${f.weather_desc || "-"}**\n• ${t("weather.temp_label")}: **${f.t || "-"} °C**\n• Hum: **${f.hu || "-"}%**`,
              inline: true,
            });
          }
        }
      } else {
        const dailyRecords = weatherRecords.filter((rec) => {
          if (!rec.local_datetime) return false;
          const recDate = rec.local_datetime.split(" ")[0] || rec.local_datetime.split("T")[0];
          return recDate === tanggalSelected;
        });

        embedDetail.setDescription(`### 📅 ${t("weather.daily_forecast_title", { date: tanggalSelected })}`);

        if (dailyRecords.length > 0) {
          for (const f of dailyRecords) {
            const timeStr = f.local_datetime
              ? f.local_datetime.split(" ")[1]?.slice(0, 5) || f.local_datetime
              : "N/A";
            embedDetail.addFields({
              name: `🕒 ${t("weather.hour_label", { time: timeStr })}`,
              value: `• ${t("weather.weather_label")}: **${f.weather_desc || "-"}**\n• ${t("weather.temp_label")}: **${f.t || "-"} °C**\n• Hum: **${f.hu || "-"}%**\n• Angin: **${f.ws || "-"} km/jam** (${f.wd || "-"})`,
              inline: true,
            });
          }
        } else {
          embedDetail.setDescription(`⚠️ ${t("weather.no_forecast_for_date", { date: tanggalSelected })}`);
        }
      }
      await interaction.editReply({ embeds: [embedDetail] });
    } catch (e) {
      Log.error("Commands", "Error executing weather command:", e);
      if (e instanceof BmkgWafError) {
        await interaction.editReply({ content: t("weather.waf_blocked") });
      } else if (e instanceof BmkgHttpError) {
        await interaction.editReply({ content: t("weather.fetch_failed", { status: e.status }) });
      } else {
        await interaction.editReply({ content: t("weather.process_failed") });
      }
    }
  }
}
