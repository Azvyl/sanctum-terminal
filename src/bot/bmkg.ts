import { Log } from "../logger.ts";

export class BmkgWafError extends Error {
  constructor(message = "BMKG WAF / Cloudflare challenge encountered") {
    super(message);
    this.name = "BmkgWafError";
  }
}

export class BmkgHttpError extends Error {
  constructor(public status: number, message?: string) {
    super(message || `BMKG HTTP Error ${status}`);
    this.name = "BmkgHttpError";
  }
}

export const BMKG_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "Referer": "https://www.bmkg.go.id/",
};

export async function bmkgFetch(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers: BMKG_HEADERS });
  } catch (err) {
    Log.error("BMKG", `Network error fetching ${url}:`, err);
    throw err;
  }

  if (response.status === 403 || response.status === 503) {
    Log.warn("BMKG", `BMKG WAF/Cloudflare challenge encountered (HTTP ${response.status}) at: ${url}`);
    throw new BmkgWafError(`BMKG WAF blocked request (HTTP ${response.status})`);
  }

  if (!response.ok) {
    Log.warn("BMKG", `BMKG HTTP ${response.status} returned for: ${url}`);
    throw new BmkgHttpError(response.status);
  }

  return response;
}

export async function bmkgFetchText(url: string): Promise<string> {
  const response = await bmkgFetch(url);
  const text = await response.text();

  if (
    text.includes("Just a moment...") ||
    text.includes("cf-browser-verification") ||
    text.includes("Cloudflare Ray ID") ||
    text.includes("Attention Required! | Cloudflare")
  ) {
    Log.warn("BMKG", `BMKG response contains Cloudflare challenge page for: ${url}`);
    throw new BmkgWafError("BMKG Cloudflare challenge page detected");
  }

  return text;
}

