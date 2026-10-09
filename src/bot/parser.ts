import { parse } from "node-html-parser";
import { UPDATE_TAGS } from "../config.ts";

export interface MinecraftArticle {
  id: number;
  url: string;
  html_url: string;
  author_id: number;
  comments_disabled: boolean;
  draft: boolean;
  promoted: boolean;
  position: number;
  vote_sum: number;
  vote_count: number;
  section_id: number;
  created_at: string;
  updated_at: string;
  name: string;
  title: string;
  source_locale: string;
  locale: string;
  outdated: boolean;
  outdated_locales: string[];
  edited_at: string;
  user_segment_id: number | null;
  permission_group_id: number;
  content_tag_ids: number[];
  label_names: string[];
  body: string;
  user_segment_ids: number[];
}

export interface ParsedArticle {
  type: "bedrock" | "java";
  version: string;
  updateType: string;
  threadName: string;
  tagId: string;
}

export function parseArticle(article: MinecraftArticle): ParsedArticle | null {
  const title = article.title || "";
  const lowercaseTitle = title.toLowerCase();
  const sectionId = article.section_id;

  let type: "bedrock" | "java" | null = null;
  if (lowercaseTitle.includes("bedrock") || sectionId === 360001185332) {
    type = "bedrock";
  } else if (lowercaseTitle.includes("java") || sectionId === 360002267532) {
    type = "java";
  }

  if (!type) return null;

  let version = "";
  const versionMatch = title.match(/(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/);
  if (versionMatch) {
    version = versionMatch[1];
  }

  let threadName = title;
  let tagId = "";
  let updateType = "Update";

  if (type === "bedrock") {
    if (sectionId === 360001185332) {
      threadName = `Beta/Preview ${version}`;
      tagId = UPDATE_TAGS.BEDROCK_PREVIEW;
      updateType = "Preview";
    } else {
      const isHotfix = lowercaseTitle.includes("hotfix");
      if (isHotfix) {
        threadName = `Bedrock ${version}`;
        tagId = UPDATE_TAGS.BEDROCK_HOTFIX;
        updateType = "Hotfix";
      } else {
        let suffix = title
          .replace(/Minecraft:\s*Bedrock\s*Edition\s*/i, "")
          .replace(/Minecraft:\s*/i, "")
          .replace(/Bedrock\s*Edition\s*/i, "")
          .replace(new RegExp(version, "g"), "")
          .replace(/Changelog/gi, "")
          .replace(/Hotfix/gi, "")
          .trim();
        suffix = suffix.replace(/^[\s\-:]+/, "").replace(/[\s\-:]+$/, "").trim();

        if (suffix && suffix.length > 2) {
          threadName = `Bedrock ${version} - ${suffix}`;
          tagId = UPDATE_TAGS.BEDROCK_GAME_DROP;
          updateType = "Game Drop";
        } else {
          threadName = `Bedrock ${version}`;
          tagId = UPDATE_TAGS.BEDROCK_MINOR_UPDATE;
          updateType = "Minor Update";
        }
      }
    }
  } else {
    if (sectionId === 360002267532) {
      const isRC = lowercaseTitle.includes("release candidate") || lowercaseTitle.includes("rc");
      const isPre = lowercaseTitle.includes("pre-release") || lowercaseTitle.includes("pre");
      if (isRC) {
        const rcMatch = title.match(/Release\s*Candidate\s*\d+/i);
        const rcStr = rcMatch ? rcMatch[0] : "Release Candidate";
        threadName = `Java ${version} ${rcStr}`;
        tagId = UPDATE_TAGS.JAVA_RELEASE_CANDIDATE;
        updateType = "Release Candidate";
      } else if (isPre) {
        const preMatch = title.match(/Pre-Release\s*\d+/i);
        const preStr = preMatch ? preMatch[0] : "Pre-Release";
        threadName = `Java ${version} ${preStr}`;
        tagId = UPDATE_TAGS.JAVA_RELEASE_CANDIDATE;
        updateType = "Pre-Release";
      } else {
        const snapshotMatch = title.match(/Snapshot\s*\d+/i);
        const snapshotStr = snapshotMatch ? snapshotMatch[0] : "Snapshot";
        threadName = `Java ${version} ${snapshotStr}`;
        tagId = UPDATE_TAGS.JAVA_SNAPSHOT;
        updateType = "Snapshot";
      }
    } else {
      const isHotfix = lowercaseTitle.includes("hotfix");
      if (isHotfix) {
        threadName = `Java ${version} Hotfix`;
        tagId = UPDATE_TAGS.JAVA_MINOR_HOTFIX;
        updateType = "Hotfix";
      } else {
        threadName = `Java ${version}`;
        tagId = UPDATE_TAGS.JAVA_GAME_DROP;
        updateType = "Game Drop";
      }
    }
  }

  threadName = threadName.replace(/\s+/g, " ").trim();
  return { type, version, updateType, threadName, tagId };
}

export function getArticleImage(html: string): string | null {
  if (!html) return null;
  const root = parse(html);
  const rawSrc = root.querySelector("img")?.getAttribute("src");
  if (!rawSrc) return null;

  if (rawSrc.startsWith("/hc/article_attachments/")) {
    return `https://feedback.minecraft.net${rawSrc}`;
  }
  if (rawSrc.startsWith("https://feedback.minecraft.net/hc/article_attachments/")) {
    return rawSrc;
  }
  return null;
}

export function getFirstParagraph(html: string): string {
  if (!html) return "";
  const root = parse(html);
  const paragraphs = root.querySelectorAll("p");
  for (const p of paragraphs) {
    const text = p.text.trim();
    if (text && !text.startsWith("Posted:") && !text.startsWith("Posted ")) {
      return text;
    }
  }
  return "";
}

// deno-lint-ignore no-explicit-any
export function deserializeNuxtData(nuxtDataArray: any[]): any[] {
  if (!Array.isArray(nuxtDataArray)) return [];
  const weatherRecords: any[] = [];
  for (const item of nuxtDataArray) {
    if (item && typeof item === "object") {
      const resolvedObj: any = {};
      let isWeatherObj = false;
      for (const [key, value] of Object.entries(item)) {
        const actualKey = isNaN(Number(key)) ? key : nuxtDataArray[Number(key)];
        let actualValue = value;
        if (typeof value === "number" && value >= 0 && value < nuxtDataArray.length) {
          actualValue = nuxtDataArray[value];
        }
        if (actualKey) {
          resolvedObj[actualKey] = actualValue;
          if (
            actualKey === "local_datetime" ||
            actualKey === "weather_desc" ||
            actualKey === "analysis_date" ||
            actualKey === "analysis_local_datetime"
          ) {
            isWeatherObj = true;
          }
        }
      }
      if (isWeatherObj && resolvedObj.local_datetime) {
        weatherRecords.push(resolvedObj);
      }
    }
  }

  if (weatherRecords.length === 0) {
    for (const item of nuxtDataArray) {
      if (item && typeof item === "object") {
        if (item.local_datetime && (item.weather_desc || item.t || item.hu)) {
          weatherRecords.push(item);
        }
      }
    }
  }
  return weatherRecords;
}
