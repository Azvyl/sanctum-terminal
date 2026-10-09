import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set } from "firebase/database";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { Log } from "../src/logger.ts";
import type { GitHubStatsData } from "../src/widgets/scheduler.ts";

const TAG = "GitHubSync";

const DEFAULT_FALLBACK_DATA: GitHubStatsData = {
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

interface FetchResult<T> {
  ok: boolean;
  data: T | null;
  rateLimited: boolean;
  status: number;
  message?: string;
}

async function requestGitHub<T>(
  url: string,
  token?: string,
  options?: RequestInit,
): Promise<FetchResult<T>> {
  const headers: Record<string, string> = {
    "User-Agent": "SanctumTerminal-GitHubSync/1.0",
    "Accept": "application/vnd.github+json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...headers,
        ...(options?.headers ? (options.headers as Record<string, string>) : {}),
      },
      signal: AbortSignal.timeout(15000),
    });

    const remaining = res.headers.get("x-ratelimit-remaining");
    const isRateLimit =
      res.status === 429 ||
      (res.status === 403 && (remaining === "0" || (await res.clone().text()).includes("rate limit")));

    if (isRateLimit) {
      Log.warn(TAG, `GitHub API rate limit encountered for URL: ${url}`);
      return { ok: false, data: null, rateLimited: true, status: res.status, message: "Rate limit reached" };
    }

    if (!res.ok) {
      const errText = await res.text();
      Log.warn(TAG, `GitHub API returned HTTP ${res.status} for ${url}: ${errText}`);
      return { ok: false, data: null, rateLimited: false, status: res.status, message: errText };
    }

    const data = (await res.json()) as T;
    return { ok: true, data, rateLimited: false, status: res.status };
  } catch (err) {
    Log.error(TAG, `Network error requesting GitHub URL: ${url}`, err);
    return {
      ok: false,
      data: null,
      rateLimited: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

interface GitHubGraphQLUser {
  contributionsCollection?: {
    totalCommitContributions?: number;
    restrictedContributionsCount?: number;
    totalPullRequestReviewContributions?: number;
    totalPullRequestContributions?: number;
    totalIssueContributions?: number;
    contributionCalendar?: {
      totalContributions?: number;
    };
  };
  currentYearContrib?: {
    contributionCalendar?: {
      totalContributions?: number;
    };
  };
  pullRequests?: { totalCount?: number };
  mergedPRs?: { totalCount?: number };
  issues?: { totalCount?: number };
}

interface FetchedResultWithStatus {
  success: boolean;
  rateLimited: boolean;
  stats?: DeepPartial<GitHubStatsData>;
  liveFlags: Record<string, boolean>;
}

async function fetchGitHubData(username: string, token?: string): Promise<FetchedResultWithStatus> {
  Log.info(TAG, `Fetching GitHub metrics for user: [${username}]...`);
  const liveFlags: Record<string, boolean> = {};

  const userRes = await requestGitHub<Record<string, unknown>>(
    `https://api.github.com/users/${username}`,
    token,
  );

  if (userRes.rateLimited) {
    return { success: false, rateLimited: true, liveFlags };
  }
  if (!userRes.ok || !userRes.data) {
    Log.error(TAG, `Failed to fetch GitHub profile for ${username}. Status: ${userRes.status}`);
    return { success: false, rateLimited: false, liveFlags };
  }

  const userData = userRes.data;
  const displayName = String(userData.name || userData.login || username);
  const company = userData.company ? String(userData.company).trim() : "";
  const followers = typeof userData.followers === "number" ? userData.followers : 0;
  const following = typeof userData.following === "number" ? userData.following : 0;
  const plan = userData.plan && typeof userData.plan === "object" ? (userData.plan as Record<string, unknown>) : null;
  const accountTier = plan?.name === "pro" ? "GitHub PRO" : "GitHub Developer";

  liveFlags["profile.username"] = true;
  liveFlags["profile.display_name"] = true;
  liveFlags["profile.affiliation"] = Boolean(company);
  liveFlags["profile.account_tier"] = true;
  liveFlags["profile.followers"] = true;
  liveFlags["profile.following"] = true;
  liveFlags["profile.badges_count"] = false;

  let orgsCount = 0;
  const orgsRes = await requestGitHub<Array<unknown>>(
    `https://api.github.com/users/${username}/orgs`,
    token,
  );
  if (orgsRes.rateLimited) {
    return { success: false, rateLimited: true, liveFlags };
  }
  if (orgsRes.ok && Array.isArray(orgsRes.data)) {
    orgsCount = orgsRes.data.length;
    liveFlags["profile.orgs_count"] = true;
  } else {
    Log.warn(TAG, `[SUB-QUERY WARNING] Orgs query failed (HTTP ${orgsRes.status}). Falling back to cached RTDB / default value.`);
    liveFlags["profile.orgs_count"] = false;
  }

  let starsEarned = 0;
  let recentReposList: string[] = [];
  const reposRes = await requestGitHub<Array<Record<string, unknown>>>(
    `https://api.github.com/users/${username}/repos?per_page=100&sort=pushed&type=owner`,
    token,
  );
  if (reposRes.rateLimited) {
    return { success: false, rateLimited: true, liveFlags };
  }
  if (reposRes.ok && Array.isArray(reposRes.data)) {
    for (const repo of reposRes.data) {
      if (typeof repo.stargazers_count === "number") {
        starsEarned += repo.stargazers_count;
      }
    }
    recentReposList = reposRes.data
      .filter((r) => !r.fork)
      .slice(0, 5)
      .map((r) => String(r.name))
      .filter(Boolean);
    liveFlags["metrics.stars_earned"] = true;
    liveFlags["contributed_to.recent_repositories"] = recentReposList.length > 0;
  } else {
    Log.warn(TAG, `[SUB-QUERY WARNING] Repos query failed (HTTP ${reposRes.status}). Falling back to cached RTDB / default value.`);
    liveFlags["metrics.stars_earned"] = false;
    liveFlags["contributed_to.recent_repositories"] = false;
  }

  let totalCommits = 0;
  let totalPrs = 0;
  let prsMerged = 0;
  let prsReviewed = 0;
  let totalIssues = 0;
  let lifetimeContributions = 0;
  let currentYearContributions = 0;
  let hasRichMetrics = false;

  if (token) {
    const userCreatedAt = new Date(String(userData.created_at));
    const userCreatedYear = userCreatedAt.getFullYear();
    const currentYear = new Date().getFullYear();

    for (let year = userCreatedYear; year <= currentYear; year++) {
      const fromDate = year === userCreatedYear
        ? userCreatedAt.toISOString()
        : `${year}-01-01T00:00:00Z`;
      const toDate = `${year}-12-31T23:59:59Z`;

      const yearlyQuery = {
        query: `
          query($login: String!, $from: DateTime!, $to: DateTime!) {
            user(login: $login) {
              contributionsCollection(from: $from, to: $to) {
                totalCommitContributions
                restrictedContributionsCount
                totalPullRequestReviewContributions
                contributionCalendar {
                  totalContributions
                }
              }
            }
          }
        `,
        variables: {
          login: username,
          from: fromDate,
          to: toDate,
        },
      };

      const res = await requestGitHub<{ data?: { user?: any } }>(
        "https://api.github.com/graphql",
        token,
        {
          method: "POST",
          body: JSON.stringify(yearlyQuery),
        },
      );

      if (res.ok && res.data?.data?.user) {
        const coll = res.data.data.user.contributionsCollection;
        const yearTotal = coll?.contributionCalendar?.totalContributions || 0;

        lifetimeContributions += yearTotal;
        totalCommits += (coll?.totalCommitContributions || 0) + (coll?.restrictedContributionsCount || 0);
        prsReviewed += coll?.totalPullRequestReviewContributions || 0;

        liveFlags["metrics.lifetime_contributions"] = true;
        liveFlags["metrics.total_commits"] = true;
        liveFlags["metrics.prs_reviewed"] = true;

        if (year === currentYear) {
          currentYearContributions = yearTotal;
          liveFlags["metrics.current_year_contributions"] = true;
        }
      } else {
        Log.warn(
          TAG,
          `[SUB-QUERY WARNING] GraphQL contribution metrics query failed for year ${year} (HTTP ${res.status}: ${res.message || "errors in query"}).`,
        );
      }
    }

    const globalCountQuery = {
      query: `
        query($login: String!) {
          user(login: $login) {
            pullRequests { totalCount }
            mergedPRs: pullRequests(states: MERGED) { totalCount }
            issues { totalCount }
          }
        }
      `,
      variables: { login: username },
    };

    const countRes = await requestGitHub<{ data?: { user?: any } }>(
      "https://api.github.com/graphql",
      token,
      {
        method: "POST",
        body: JSON.stringify(globalCountQuery),
      },
    );

    if (countRes.ok && countRes.data?.data?.user) {
      const u = countRes.data.data.user;
      totalPrs = u.pullRequests?.totalCount ?? 0;
      prsMerged = u.mergedPRs?.totalCount ?? 0;
      totalIssues = u.issues?.totalCount ?? 0;
      hasRichMetrics = true;
      liveFlags["metrics.total_prs"] = true;
      liveFlags["metrics.prs_merged"] = true;
      liveFlags["metrics.total_issues"] = true;
      Log.success(TAG, "GraphQL contribution metrics retrieved successfully.");
    } else {
      Log.warn(
        TAG,
        `[SUB-QUERY WARNING] GraphQL count query failed (HTTP ${countRes.status}: ${countRes.message || "errors in query"}).`,
      );
    }
  } else {
    Log.warn(
      TAG,
      "[SUB-QUERY WARNING] GITHUB_TOKEN is not provided. Skipping GraphQL contribution metrics query.",
    );
  }

  if (!hasRichMetrics && token) {
    try {
      const [prsRes, mergedRes, issuesRes] = await Promise.all([
        requestGitHub<{ total_count?: number }>(
          `https://api.github.com/search/issues?q=type:pr+author:${username}`,
          token,
        ),
        requestGitHub<{ total_count?: number }>(
          `https://api.github.com/search/issues?q=type:pr+author:${username}+is:merged`,
          token,
        ),
        requestGitHub<{ total_count?: number }>(
          `https://api.github.com/search/issues?q=type:issue+author:${username}`,
          token,
        ),
      ]);

      if (prsRes.ok && typeof prsRes.data?.total_count === "number") {
        totalPrs = prsRes.data.total_count;
        liveFlags["metrics.total_prs"] = true;
      } else {
        Log.warn(TAG, `[SUB-QUERY WARNING] Search API PRs query failed (HTTP ${prsRes.status}).`);
        liveFlags["metrics.total_prs"] = false;
      }

      if (mergedRes.ok && typeof mergedRes.data?.total_count === "number") {
        prsMerged = mergedRes.data.total_count;
        liveFlags["metrics.prs_merged"] = true;
      } else {
        Log.warn(TAG, `[SUB-QUERY WARNING] Search API Merged PRs query failed (HTTP ${mergedRes.status}).`);
        liveFlags["metrics.prs_merged"] = false;
      }

      if (issuesRes.ok && typeof issuesRes.data?.total_count === "number") {
        totalIssues = issuesRes.data.total_count;
        liveFlags["metrics.total_issues"] = true;
      } else {
        Log.warn(TAG, `[SUB-QUERY WARNING] Search API Issues query failed (HTTP ${issuesRes.status}).`);
        liveFlags["metrics.total_issues"] = false;
      }
    } catch (err) {
      Log.warn(TAG, "[SUB-QUERY WARNING] Search API sub-query exception:", err);
    }
  }

  if (!hasRichMetrics) {
    if (liveFlags["metrics.total_commits"] === undefined) liveFlags["metrics.total_commits"] = false;
    if (liveFlags["metrics.prs_reviewed"] === undefined) liveFlags["metrics.prs_reviewed"] = false;
    if (liveFlags["metrics.lifetime_contributions"] === undefined) liveFlags["metrics.lifetime_contributions"] = false;
    if (liveFlags["metrics.current_year_contributions"] === undefined) liveFlags["metrics.current_year_contributions"] = false;
  }

  liveFlags["contributed_to.core_repositories"] = false;

  const recentReposStr =
    recentReposList.length > 0 ? recentReposList.join(", ") : undefined;

  const result: DeepPartial<GitHubStatsData> = {
    profile: {
      username,
      display_name: displayName,
      affiliation: company || undefined,
      account_tier: accountTier,
      followers,
      following,
      badges_count: undefined,
      orgs_count: liveFlags["profile.orgs_count"] ? orgsCount : undefined,
    },
    metrics: {
      stars_earned: liveFlags["metrics.stars_earned"] ? starsEarned : undefined,
      total_commits: liveFlags["metrics.total_commits"] ? totalCommits : undefined,
      total_prs: liveFlags["metrics.total_prs"] ? totalPrs : undefined,
      prs_merged: liveFlags["metrics.prs_merged"] ? prsMerged : undefined,
      prs_reviewed: liveFlags["metrics.prs_reviewed"] ? prsReviewed : undefined,
      total_issues: liveFlags["metrics.total_issues"] ? totalIssues : undefined,
      lifetime_contributions: liveFlags["metrics.lifetime_contributions"] ? lifetimeContributions : undefined,
      current_year_contributions: liveFlags["metrics.current_year_contributions"] ? currentYearContributions : undefined,
    },
    contributed_to: {
      core_repositories: undefined,
      recent_repositories: recentReposStr,
    },
  };

  return { success: true, rateLimited: false, stats: result, liveFlags };
}

interface ResolvedField<T> {
  value: T;
  tag: "[FETCHED]" | "[FALLBACK / CACHED]";
  detail: string;
}

function resolveField<T>(
  isLive: boolean | undefined,
  liveVal: T | undefined | null,
  cachedVal: T | undefined | null,
  defaultVal: T,
): ResolvedField<T> {
  if (isLive && liveVal !== undefined && liveVal !== null) {
    return {
      value: liveVal,
      tag: "[FETCHED]",
      detail: "Live API",
    };
  }
  if (cachedVal !== undefined && cachedVal !== null) {
    return {
      value: cachedVal,
      tag: "[FALLBACK / CACHED]",
      detail: "Cached RTDB Record",
    };
  }
  return {
    value: defaultVal,
    tag: "[FALLBACK / CACHED]",
    detail: "Static Default Value",
  };
}

async function runSync() {
  Log.info(TAG, "Starting GitHub Live Stats worker sync...");

  const dbUrl = Deno.env.get("FIREBASE_DB_URL");
  if (!dbUrl) {
    Log.error(TAG, "Missing FIREBASE_DB_URL environment variable. Cannot proceed.");
    Deno.exit(1);
  }

  const app = initializeApp({
    databaseURL: dbUrl,
    apiKey: Deno.env.get("FIREBASE_API_KEY") || undefined,
    authDomain: Deno.env.get("FIREBASE_AUTH_DOMAIN") || undefined,
    projectId: Deno.env.get("FIREBASE_PROJECT_ID") || undefined,
    storageBucket: Deno.env.get("FIREBASE_STORAGE_BUCKET") || undefined,
    messagingSenderId: Deno.env.get("FIREBASE_MESSAGING_SENDER_ID") || undefined,
    appId: Deno.env.get("FIREBASE_APP_ID") || undefined,
  });

  const db = getDatabase(app);

  const authEmail = Deno.env.get("FIREBASE_AUTH_EMAIL");
  const authPassword = Deno.env.get("FIREBASE_AUTH_PASSWORD");

  if (authEmail && authPassword) {
    try {
      await signInWithEmailAndPassword(getAuth(app), authEmail, authPassword);
      Log.success(TAG, `Firebase Authenticated as: [${authEmail}].`);
    } catch (err) {
      Log.error(TAG, "Firebase Authentication failed:", err);
      Deno.exit(1);
    }
  }

  const githubPath = "schale/widget_data/github";
  const targetRef = ref(db, githubPath);

  let existingData: DeepPartial<GitHubStatsData> | null = null;
  try {
    const snap = await get(targetRef);
    if (snap.exists()) {
      existingData = snap.val();
      Log.info(TAG, "Existing RTDB GitHub data retrieved for fallback cache.");
    } else {
      Log.info(TAG, "No existing RTDB GitHub data found.");
    }
  } catch (err) {
    Log.warn(TAG, "Failed reading existing RTDB data:", err);
  }

  const token = Deno.env.get("GITHUB_TOKEN");
  const username = Deno.env.get("GITHUB_USERNAME") || "Azvyl";

  if (!token) {
    Log.warn(
      TAG,
      "GITHUB_TOKEN is not set in environment. Queries may be strictly rate limited by GitHub.",
    );
  }

  const fetchResult = await fetchGitHubData(username, token);

  if (fetchResult.rateLimited) {
    Log.error(
      TAG,
      "CRITICAL: GitHub API rate limit reached. Sync aborted to prevent overwriting existing data with empty values.",
    );
    Deno.exit(0);
  }

  if (!fetchResult.success || !fetchResult.stats) {
    Log.error(
      TAG,
      "Failed to retrieve data from GitHub API. Sync aborted. Preserving existing database records.",
    );
    Deno.exit(0);
  }

  const s = fetchResult.stats;
  const lf = fetchResult.liveFlags;
  const exP = existingData?.profile;
  const exM = existingData?.metrics;
  const exC = existingData?.contributed_to;
  const defP = DEFAULT_FALLBACK_DATA.profile;
  const defM = DEFAULT_FALLBACK_DATA.metrics;
  const defC = DEFAULT_FALLBACK_DATA.contributed_to;

  const resUsername = resolveField(lf["profile.username"], s.profile?.username, exP?.username, defP.username);
  const resDisplayName = resolveField(lf["profile.display_name"], s.profile?.display_name, exP?.display_name, defP.display_name);
  const resAffiliation = resolveField(lf["profile.affiliation"], s.profile?.affiliation, exP?.affiliation, defP.affiliation);
  const resAccountTier = resolveField(lf["profile.account_tier"], s.profile?.account_tier, exP?.account_tier, defP.account_tier);
  const resFollowers = resolveField(lf["profile.followers"], s.profile?.followers, exP?.followers, defP.followers);
  const resFollowing = resolveField(lf["profile.following"], s.profile?.following, exP?.following, defP.following);
  const resBadgesCount = resolveField(lf["profile.badges_count"], s.profile?.badges_count, exP?.badges_count, defP.badges_count);
  const resOrgsCount = resolveField(lf["profile.orgs_count"], s.profile?.orgs_count, exP?.orgs_count, defP.orgs_count);

  const resStarsEarned = resolveField(lf["metrics.stars_earned"], s.metrics?.stars_earned, exM?.stars_earned, defM.stars_earned);
  const resTotalCommits = resolveField(lf["metrics.total_commits"], s.metrics?.total_commits, exM?.total_commits, defM.total_commits);
  const resTotalPrs = resolveField(lf["metrics.total_prs"], s.metrics?.total_prs, exM?.total_prs, defM.total_prs);
  const resPrsMerged = resolveField(lf["metrics.prs_merged"], s.metrics?.prs_merged, exM?.prs_merged, defM.prs_merged);
  const resPrsReviewed = resolveField(lf["metrics.prs_reviewed"], s.metrics?.prs_reviewed, exM?.prs_reviewed, defM.prs_reviewed);
  const resTotalIssues = resolveField(lf["metrics.total_issues"], s.metrics?.total_issues, exM?.total_issues, defM.total_issues);
  const resLifetimeContrib = resolveField(lf["metrics.lifetime_contributions"], s.metrics?.lifetime_contributions, exM?.lifetime_contributions, defM.lifetime_contributions);
  const resCurrentYearContrib = resolveField(lf["metrics.current_year_contributions"], s.metrics?.current_year_contributions, exM?.current_year_contributions, defM.current_year_contributions);

  const resCoreRepos = resolveField(lf["contributed_to.core_repositories"], s.contributed_to?.core_repositories, exC?.core_repositories, defC.core_repositories);
  const resRecentRepos = resolveField(lf["contributed_to.recent_repositories"], s.contributed_to?.recent_repositories, exC?.recent_repositories, defC.recent_repositories);

  const reportLines = [
    "================================================================================",
    "                   GITHUB LIVE STATS SYNC STATUS REPORT                        ",
    "================================================================================",
    "PROFILE METRICS:",
    `  ${resUsername.tag.padEnd(21)} username: "${resUsername.value}" (${resUsername.detail})`,
    `  ${resDisplayName.tag.padEnd(21)} display_name: "${resDisplayName.value}" (${resDisplayName.detail})`,
    `  ${resAffiliation.tag.padEnd(21)} affiliation: "${resAffiliation.value}" (${resAffiliation.detail})`,
    `  ${resAccountTier.tag.padEnd(21)} account_tier: "${resAccountTier.value}" (${resAccountTier.detail})`,
    `  ${resFollowers.tag.padEnd(21)} followers: ${resFollowers.value} (${resFollowers.detail})`,
    `  ${resFollowing.tag.padEnd(21)} following: ${resFollowing.value} (${resFollowing.detail})`,
    `  ${resBadgesCount.tag.padEnd(21)} badges_count: ${resBadgesCount.value} (${resBadgesCount.detail})`,
    `  ${resOrgsCount.tag.padEnd(21)} orgs_count: ${resOrgsCount.value} (${resOrgsCount.detail})`,
    "--------------------------------------------------------------------------------",
    "CONTRIBUTION & ACTIVITY METRICS:",
    `  ${resStarsEarned.tag.padEnd(21)} stars_earned: ${resStarsEarned.value} (${resStarsEarned.detail})`,
    `  ${resTotalCommits.tag.padEnd(21)} total_commits: ${resTotalCommits.value} (${resTotalCommits.detail})`,
    `  ${resTotalPrs.tag.padEnd(21)} total_prs: ${resTotalPrs.value} (${resTotalPrs.detail})`,
    `  ${resPrsMerged.tag.padEnd(21)} prs_merged: ${resPrsMerged.value} (${resPrsMerged.detail})`,
    `  ${resPrsReviewed.tag.padEnd(21)} prs_reviewed: ${resPrsReviewed.value} (${resPrsReviewed.detail})`,
    `  ${resTotalIssues.tag.padEnd(21)} total_issues: ${resTotalIssues.value} (${resTotalIssues.detail})`,
    `  ${resLifetimeContrib.tag.padEnd(21)} lifetime_contributions: ${resLifetimeContrib.value} (${resLifetimeContrib.detail})`,
    `  ${resCurrentYearContrib.tag.padEnd(21)} current_year_contributions: ${resCurrentYearContrib.value} (${resCurrentYearContrib.detail})`,
    "--------------------------------------------------------------------------------",
    "CONTRIBUTED REPOSITORIES:",
    `  ${resCoreRepos.tag.padEnd(21)} core_repositories: "${resCoreRepos.value}" (${resCoreRepos.detail})`,
    `  ${resRecentRepos.tag.padEnd(21)} recent_repositories: "${resRecentRepos.value}" (${resRecentRepos.detail})`,
    "================================================================================",
  ];

  console.log(reportLines.join("\n"));

  const finalPayload: GitHubStatsData = {
    profile: {
      username: resUsername.value,
      display_name: resDisplayName.value,
      affiliation: resAffiliation.value,
      account_tier: resAccountTier.value,
      followers: resFollowers.value,
      following: resFollowing.value,
      badges_count: resBadgesCount.value,
      orgs_count: resOrgsCount.value,
    },
    metrics: {
      stars_earned: resStarsEarned.value,
      total_commits: resTotalCommits.value,
      total_prs: resTotalPrs.value,
      prs_merged: resPrsMerged.value,
      prs_reviewed: resPrsReviewed.value,
      total_issues: resTotalIssues.value,
      lifetime_contributions: resLifetimeContrib.value,
      current_year_contributions: resCurrentYearContrib.value,
    },
    contributed_to: {
      core_repositories: resCoreRepos.value,
      recent_repositories: resRecentRepos.value,
    },
  };

  try {
    Log.info(TAG, `Writing GitHub stats to Firebase RTDB path: [${githubPath}]...`);
    await set(targetRef, finalPayload);
    Log.success(TAG, "Successfully synced GitHub stats to Firebase RTDB!");
  } catch (err) {
    Log.error(TAG, "Failed writing to Firebase RTDB:", err);
    Deno.exit(1);
  }

  Deno.exit(0);
}

if (import.meta.main) {
  runSync();
}
