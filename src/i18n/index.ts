import { ConfigManager } from "../config.ts";
import { en } from "./locales/en.ts";
import { id } from "./locales/id.ts";

export type Locale = "en" | "id";

const dictionaries: Record<Locale, Record<string, unknown>> = {
  en,
  id,
};

let explicitLocale: Locale | null = null;

export function setLocale(locale: Locale): void {
  explicitLocale = locale;
}

export function getLocale(): Locale {
  if (explicitLocale) return explicitLocale;
  const cfg = ConfigManager.APP_LOCALE;
  return cfg === "id" ? "id" : "en";
}

function resolveNestedKey(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const currentLocale = getLocale();
  let template = resolveNestedKey(dictionaries[currentLocale], key);

  if (!template && currentLocale !== "en") {
    template = resolveNestedKey(dictionaries.en, key);
  }

  if (!template) {
    return key;
  }

  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_, match) => {
    return match in params ? String(params[match]) : `{${match}}`;
  });
}
