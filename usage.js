#!/usr/bin/env node
const { spawn, execSync, execFileSync } = require("node:child_process");
const https = require("node:https");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createHash } = require("node:crypto");

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, ".usage-config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

// ─── ANSI helpers ────────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const BG_RED = "\x1b[41m";
const BG_GREEN = "\x1b[42m";
const BG_YELLOW = "\x1b[43m";

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function progressBar(pct, width = 30) {
  if (pct == null) return `${DIM}(no data)${RESET}`;
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  let color = GREEN;
  if (pct >= 90) color = RED;
  else if (pct >= 70) color = YELLOW;
  const bar = color + "█".repeat(filled) + DIM + "░".repeat(empty) + RESET;
  return `${bar} ${BOLD}${pct}%${RESET}`;
}

function formatTimeUntil(resetStr) {
  if (!resetStr) return `${DIM}(unknown)${RESET}`;
  return `${CYAN}${resetStr}${RESET}`;
}

function parseClaudeResetToDate(raw) {
  if (!raw || typeof raw !== "string") return null;
  const now = new Date();
  const year = now.getFullYear();
  const monthNames = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

  let m = raw.match(/(\w{3})\s+(\d{1,2})\s+at\s+(\d{1,2})\s*(am|pm)/i);
  if (m) {
    const monthIdx = monthNames[m[1]];
    if (monthIdx != null) {
      let h = parseInt(m[3], 10);
      if (m[4].toLowerCase() === "pm" && h < 12) h += 12;
      else if (m[4].toLowerCase() === "am" && h === 12) h = 0;
      const d = new Date(year, monthIdx, parseInt(m[2], 10), h, 0, 0);
      return d > now ? d : new Date(year + 1, monthIdx, parseInt(m[2], 10), h, 0, 0);
    }
  }

  m = raw.match(/(\w{3})\s+(\d{1,2})(?:\s|$|\))/);
  if (m) {
    const monthIdx = monthNames[m[1]];
    if (monthIdx != null) {
      const d = new Date(year, monthIdx, parseInt(m[2], 10), 12, 0, 0);
      return d > now ? d : new Date(year + 1, monthIdx, parseInt(m[2], 10), 12, 0, 0);
    }
  }

  m = raw.match(/(\d{1,2})\s*(am|pm)/i);
  if (m) {
    let h = parseInt(m[1], 10);
    if (m[2].toLowerCase() === "pm" && h < 12) h += 12;
    else if (m[2].toLowerCase() === "am" && h === 12) h = 0;
    const d = new Date(year, now.getMonth(), now.getDate(), h, 0, 0);
    return d > now ? d : new Date(year, now.getMonth(), now.getDate() + 1, h, 0, 0);
  }

  return null;
}

function formatClaudeReset(raw) {
  const date = parseClaudeResetToDate(raw);
  return date ? formatResetDate(date) : raw;
}

function heading(text) {
  const line = "─".repeat(60);
  return `\n${DIM}${line}${RESET}\n${BOLD}${text}${RESET}\n${DIM}${line}${RESET}`;
}

function sectionRow(label, pctOrValue, resetLabel, resetValue) {
  const pctStr =
    typeof pctOrValue === "number" || pctOrValue == null
      ? progressBar(pctOrValue)
      : pctOrValue;
  const parts = [`  ${BOLD}${label}${RESET}  ${pctStr}`];
  if (resetLabel) {
    parts.push(`    ${DIM}${resetLabel}:${RESET} ${formatTimeUntil(resetValue)}`);
  }
  return parts.join("\n");
}

// ─── Claude Code: fetch via expect script ────────────────────────────────────
function fetchClaudeUsage() {
  return new Promise((resolve) => {
    const expectScript = path.join(__dirname, "claude_usage.expect");
    if (!fs.existsSync(expectScript)) {
      resolve({ error: "claude_usage.expect not found" });
      return;
    }

    const debug = process.env.CLAUDE_USAGE_DEBUG === "1" || process.env.CLAUDE_USAGE_DEBUG === "true";
    const timeoutEnv = Number(process.env.CLAUDE_USAGE_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(timeoutEnv) && timeoutEnv >= 5000 && timeoutEnv <= 120000
        ? timeoutEnv
        : 35000;

    const child = spawn(expectScript, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    const hasUsageData = () =>
      /Current session|Current week|\d+%\s*used/i.test(out);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 && !hasUsageData()) {
        const exitDesc =
          signal === "SIGKILL"
            ? "timed out (killed by SIGKILL)"
            : signal
              ? `killed by ${signal}`
              : `exited ${code}`;
        let errorMsg = `expect script ${exitDesc}${err ? `: ${err.slice(0, 200)}` : ""}`;
        if (debug) {
          const debugPath = path.join(__dirname, ".claude-usage-debug.txt");
          const envInfo = [
            `TERM=${process.env.TERM}`,
            `SHELL=${process.env.SHELL}`,
            `PATH (first 3): ${(process.env.PATH || "").split(path.delimiter).slice(0, 3).join(path.delimiter)}`,
            `Exit: code=${code} signal=${signal}`,
            "",
            "--- stdout ---",
            out,
            "",
            "--- stderr ---",
            err,
          ].join("\n");
          fs.writeFileSync(debugPath, envInfo, "utf8");
          errorMsg += `\n  Debug output written to ${debugPath}`;
        }
        resolve({ error: errorMsg });
        return;
      }

      if (debug && (code !== 0 || !hasUsageData())) {
        const debugPath = path.join(__dirname, ".claude-usage-debug.txt");
        fs.writeFileSync(
          debugPath,
          [`Exit: code=${code} signal=${signal}`, "", "--- stdout ---", out, "", "--- stderr ---", err].join("\n"),
          "utf8"
        );
      }

      const parsed = parseClaudeUsage(out);
      resolve(parsed);
    });
  });
}

function parseClaudeUsage(text) {
  const clean = stripAnsi(text).replace(/\r/g, "\n");
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const normalize = (line) =>
    line
      .toLowerCase()
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/[^a-z0-9]+/g, "");

  const findSectionIndex = (token) => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (normalize(lines[i]).includes(token)) return i;
    }
    return -1;
  };

  const readSection = (idx) => {
    if (idx < 0) return { pct: null, reset: null };
    const window = lines.slice(idx, idx + 12);
    let pct = null;
    for (const line of window) {
      const m = line.match(/(\d{1,3})%\s*used/i);
      if (m) {
        pct = Number(m[1]);
        break;
      }
    }
    // Also try to match bare percentage like "90%" without "used"
    if (pct === null) {
      for (const line of window) {
        const m = line.match(/(\d{1,3})%/);
        if (m) {
          pct = Number(m[1]);
          break;
        }
      }
    }

    let reset = null;
    const resetLine = window.find((line) => /rese/i.test(normalize(line)));
    if (resetLine) {
      reset = resetLine
        .replace(/.*rese(?:ts?|s)\s*/i, "")
        .replace(/^[.\-:·]+\s*/, "")
        .trim();
      if (!reset) reset = null;
      else {
        // Re-insert spaces that got stripped by TUI rendering
        // e.g. "Feb21at12pm(America/New_York)" -> "Feb 21 at 12pm (America/New_York)"
        reset = reset
          .replace(/([a-zA-Z])(\d)/g, "$1 $2")
          .replace(/(\d)([a-zA-Z])/g, "$1 $2")
          .replace(/\(/, " (")
          .replace(/\s{2,}/g, " ")
          .trim();
      }
    }
    return { pct, reset };
  };

  const session = readSection(findSectionIndex("currentsession"));
  const week = readSection(findSectionIndex("currentweek"));
  const extra = readSection(findSectionIndex("extrausage"));

  const compact = clean.replace(/\s+/g, "");
  const moneyMatch = compact.match(
    /\$([0-9]+\.[0-9]{2})\/\$([0-9]+\.[0-9]{2})spent/i
  );
  const extraSpentUsd = moneyMatch ? Number(moneyMatch[1]) : null;
  const extraCapUsd = moneyMatch ? Number(moneyMatch[2]) : null;

  return {
    session_used_pct: session.pct,
    week_used_pct: week.pct,
    extra_used_pct: extra.pct,
    extra_spent_usd: extraSpentUsd,
    extra_cap_usd: extraCapUsd,
    session_resets: session.reset,
    week_resets: week.reset,
    extra_resets: extra.reset,
  };
}

// ─── Codex: fetch via CLI OAuth credentials ──────────────────────────────────
function resolveCodexHomePath() {
  const configured = process.env.CODEX_HOME?.trim();
  const home = configured || path.join(os.homedir(), ".codex");
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function computeCodexKeychainAccount(codexHome) {
  const hash = createHash("sha256").update(codexHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractCodexAccountIdFromToken(token) {
  const payload = decodeJwtPayload(token);
  const authClaim = payload?.["https://api.openai.com/auth"];
  if (authClaim?.chatgpt_account_id) {
    return String(authClaim.chatgpt_account_id);
  }
  return null;
}

function readCodexCliCredentials() {
  const codexHome = resolveCodexHomePath();

  if (process.platform === "darwin") {
    try {
      const account = computeCodexKeychainAccount(codexHome);
      const secret = execSync(
        `security find-generic-password -s "Codex Auth" -a "${account}" -w`,
        {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        }
      ).trim();
      const parsed = JSON.parse(secret);
      const tokens = parsed?.tokens;
      if (tokens?.access_token) {
        return {
          access_token: String(tokens.access_token),
          account_id:
            typeof tokens.account_id === "string" ? tokens.account_id : null,
          source: "macOS keychain",
        };
      }
    } catch {
      // Fallback to file-based auth below.
    }
  }

  const authPath = path.join(codexHome, "auth.json");
  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw);
    const tokens = parsed?.tokens;
    if (tokens?.access_token) {
      return {
        access_token: String(tokens.access_token),
        account_id: typeof tokens.account_id === "string" ? tokens.account_id : null,
        source: authPath,
      };
    }
  } catch {
    // no-op
  }

  return null;
}

function fetchCodexUsage() {
  return new Promise((resolve) => {
    const credentials = readCodexCliCredentials();
    if (!credentials?.access_token) {
      resolve({
        error:
          "No Codex CLI OAuth credentials found. Run `codex auth login` and retry.",
      });
      return;
    }

    const accountId =
      credentials.account_id ||
      extractCodexAccountIdFromToken(credentials.access_token);

    const options = {
      hostname: "chatgpt.com",
      path: "/backend-api/wham/usage",
      method: "GET",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "User-Agent":
          "ai-agent-usage-monitor",
        Accept: "application/json",
      },
    };
    if (accountId) {
      options.headers["ChatGPT-Account-Id"] = accountId;
    }

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({
            error:
              "Codex token expired or unauthorized. Run `codex auth login` and retry.",
          });
          return;
        }
        if (res.statusCode !== 200) {
          resolve({
            error: `Codex usage API returned ${res.statusCode}`,
          });
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve(
            parseCodexWhamUsage({
              ...data,
              _credential_source: credentials.source,
            })
          );
        } catch (e) {
          resolve({ error: `Failed to parse Codex usage: ${e.message}` });
        }
      });
    });
    req.on("error", (e) =>
      resolve({ error: `Codex usage request failed: ${e.message}` })
    );
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ error: "Codex usage request timed out" });
    });
    req.end();
  });
}

function parseCodexWhamUsage(data) {
  const toPct = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  };
  const toLabel = (seconds, fallback) => {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    const hours = Math.round(n / 3600);
    return hours >= 24 ? "Day" : `${hours}h`;
  };

  const result = {
    primary_label: null,
    primary_used_pct: null,
    primary_resets: null,
    secondary_label: null,
    secondary_used_pct: null,
    secondary_resets: null,
    five_hour_used_pct: null,
    five_hour_resets: null,
    weekly_used_pct: null,
    weekly_resets: null,
    plan: null,
    credential_source: data?._credential_source ?? null,
  };

  const primary = data?.rate_limit?.primary_window;
  const secondary = data?.rate_limit?.secondary_window;

  if (primary) {
    const seconds = Number(primary.limit_window_seconds);
    const pct = toPct(primary.used_percent);
    const reset = primary.reset_at
      ? formatResetDate(new Date(primary.reset_at * 1000))
      : null;

    result.primary_label = toLabel(seconds, "Primary");
    result.primary_used_pct = pct;
    result.primary_resets = reset;

    if (Number.isFinite(seconds) && seconds <= 6 * 3600) {
      result.five_hour_used_pct = pct;
      result.five_hour_resets = reset;
    }
    if (Number.isFinite(seconds) && seconds >= 6 * 24 * 3600) {
      result.weekly_used_pct = pct;
      result.weekly_resets = reset;
    }
  }

  if (secondary) {
    const seconds = Number(secondary.limit_window_seconds);
    const pct = toPct(secondary.used_percent);
    const reset = secondary.reset_at
      ? formatResetDate(new Date(secondary.reset_at * 1000))
      : null;

    result.secondary_label = toLabel(seconds, "Secondary");
    result.secondary_used_pct = pct;
    result.secondary_resets = reset;

    if (Number.isFinite(seconds) && seconds <= 6 * 3600) {
      result.five_hour_used_pct = pct;
      result.five_hour_resets = reset;
    }
    if (Number.isFinite(seconds) && seconds >= 6 * 24 * 3600) {
      result.weekly_used_pct = pct;
      result.weekly_resets = reset;
    }
  }

  if (data?.plan_type) {
    result.plan = String(data.plan_type);
  }

  if (data?.credits?.balance !== undefined && data?.credits?.balance !== null) {
    const balance = Number(data.credits.balance);
    if (Number.isFinite(balance)) {
      result.plan = result.plan
        ? `${result.plan} ($${balance.toFixed(2)})`
        : `$${balance.toFixed(2)}`;
    }
  }

  return result;
}

// ─── Cursor: fetch via API ───────────────────────────────────────────────────
function fetchCursorUsage(config) {
  return new Promise((resolve) => {
    const credentials = readCursorCredentials(config);
    if (!credentials?.access_token) {
      resolve({
        error:
          "No Cursor auth token found. Open Cursor and sign in, or set CURSOR_ACCESS_TOKEN / cursor_access_token.",
      });
      return;
    }

    Promise.all([
      fetchCursorDashboardJson(
        credentials.access_token,
        "GetCurrentPeriodUsage",
        {}
      ),
      fetchCursorDashboardJson(credentials.access_token, "GetPlanInfo", {}),
      fetchCursorApiJson(credentials.access_token, "/auth/full_stripe_profile"),
      fetchCursorApiJson(credentials.access_token, "/auth/usage"),
    ])
      .then(
        ([
          dashboardUsageResponse,
          dashboardPlanResponse,
          profileResponse,
          legacyUsageResponse,
        ]) => {
          const hasDashboardUsage =
            !dashboardUsageResponse.error && dashboardUsageResponse.data;
          const hasLegacyUsage =
            !legacyUsageResponse.error && legacyUsageResponse.data;

          if (!hasDashboardUsage && !hasLegacyUsage) {
            resolve({
              error:
                dashboardUsageResponse.error ||
                legacyUsageResponse.error ||
                "Cursor usage is unavailable",
            });
            return;
          }

          const parsed = hasDashboardUsage
            ? parseCursorUsage(dashboardUsageResponse.data)
            : parseCursorUsage(legacyUsageResponse.data);
          parsed.auth_source = credentials.source;

          if (hasDashboardUsage && hasLegacyUsage) {
            mergeCursorUsage(parsed, parseCursorUsage(legacyUsageResponse.data));
          }

          applyCursorCredentialMetadata(parsed, credentials);

          if (!dashboardPlanResponse.error && dashboardPlanResponse.data) {
            applyCursorPlanInfo(parsed, dashboardPlanResponse.data);
          }

          if (!profileResponse.error && profileResponse.data) {
            applyCursorStripeProfile(parsed, profileResponse.data);
          }

          resolve(parsed);
        }
      )
      .catch((e) =>
        resolve({ error: `Failed to fetch Cursor usage: ${e.message}` })
      );
  });
}

function cursorStateDbPaths() {
  const cursorUserDir = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User"
  );
  const paths = [path.join(cursorUserDir, "globalStorage", "state.vscdb")];
  const profilesDir = path.join(cursorUserDir, "profiles");
  try {
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.push(
        path.join(
          profilesDir,
          entry.name,
          "globalStorage",
          "state.vscdb"
        )
      );
    }
  } catch {
    // no-op
  }
  return [...new Set(paths)];
}

function readCursorStateValue(dbPath, key) {
  try {
    const safeKey = key.replace(/'/g, "''");
    const query = `SELECT value FROM ItemTable WHERE key='${safeKey}' LIMIT 1;`;
    const out = execFileSync("sqlite3", [dbPath, query], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function readCursorCredentials(config) {
  const envToken = process.env.CURSOR_ACCESS_TOKEN?.trim();
  if (envToken) {
    return {
      access_token: envToken,
      source: "CURSOR_ACCESS_TOKEN",
    };
  }

  const configuredToken =
    typeof config.cursor_access_token === "string"
      ? config.cursor_access_token.trim()
      : "";
  if (configuredToken) {
    return {
      access_token: configuredToken,
      source: CONFIG_PATH,
    };
  }

  for (const dbPath of cursorStateDbPaths()) {
    if (!fs.existsSync(dbPath)) continue;
    const accessToken = readCursorStateValue(dbPath, "cursorAuth/accessToken");
    if (!accessToken) continue;
    return {
      access_token: accessToken,
      source: dbPath,
      membership_type: readCursorStateValue(
        dbPath,
        "cursorAuth/stripeMembershipType"
      ),
      subscription_status: readCursorStateValue(
        dbPath,
        "cursorAuth/stripeSubscriptionStatus"
      ),
    };
  }

  return null;
}

function fetchCursorApiJson(accessToken, apiPath) {
  return new Promise((resolve) => {
    const options = {
      hostname: "api2.cursor.sh",
      path: apiPath,
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "ai-agent-usage-monitor",
        Accept: "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({
            error:
              "Cursor auth token expired or unauthorized. Open Cursor and sign in again.",
          });
          return;
        }
        if (res.statusCode !== 200) {
          resolve({
            error: `Cursor API ${apiPath} returned ${res.statusCode}`,
          });
          return;
        }
        try {
          resolve({ data: JSON.parse(body) });
        } catch (e) {
          resolve({ error: `Failed to parse Cursor API ${apiPath}: ${e.message}` });
        }
      });
    });
    req.on("error", (e) =>
      resolve({ error: `Cursor API ${apiPath} request failed: ${e.message}` })
    );
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ error: `Cursor API ${apiPath} request timed out` });
    });
    req.end();
  });
}

function fetchCursorDashboardJson(accessToken, methodName, payload = {}) {
  return new Promise((resolve) => {
    const apiPath = `/aiserver.v1.DashboardService/${methodName}`;
    const body = JSON.stringify(payload || {});
    const options = {
      hostname: "api2.cursor.sh",
      path: apiPath,
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "ai-agent-usage-monitor",
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = "";
      res.on("data", (d) => (responseBody += d));
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({
            error:
              "Cursor auth token expired or unauthorized. Open Cursor and sign in again.",
          });
          return;
        }
        if (res.statusCode !== 200) {
          resolve({
            error: `Cursor API ${apiPath} returned ${res.statusCode}`,
          });
          return;
        }
        try {
          resolve({ data: JSON.parse(responseBody) });
        } catch (e) {
          resolve({ error: `Failed to parse Cursor API ${apiPath}: ${e.message}` });
        }
      });
    });
    req.on("error", (e) =>
      resolve({ error: `Cursor API ${apiPath} request failed: ${e.message}` })
    );
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ error: `Cursor API ${apiPath} request timed out` });
    });
    req.write(body);
    req.end();
  });
}

function applyCursorCredentialMetadata(parsed, credentials) {
  if (credentials.membership_type && !parsed.plan) {
    parsed.plan = String(credentials.membership_type);
  }
  if (credentials.subscription_status && !parsed.subscription_status) {
    parsed.subscription_status = String(credentials.subscription_status);
  }
}

function applyCursorPlanInfo(parsed, planInfoResponse) {
  const planInfo = planInfoResponse?.planInfo;
  if (!planInfo || typeof planInfo !== "object") return;

  const planParts = [];
  if (planInfo.planName) planParts.push(String(planInfo.planName));
  if (planInfo.price) planParts.push(String(planInfo.price));
  if (planParts.length > 0) {
    parsed.plan = planParts.join(" ");
  }

  const billingCycleEnd = Number(planInfo.billingCycleEnd);
  if (Number.isFinite(billingCycleEnd) && billingCycleEnd > 0) {
    parsed.monthly_resets = formatResetDate(new Date(billingCycleEnd));
  }
}

function applyCursorStripeProfile(parsed, profile) {
  const membership = profile.membershipType || profile.individualMembershipType;
  const details = [];
  if (profile.isYearlyPlan) details.push("yearly");
  if (profile.isOnStudentPlan) details.push("student");

  if (membership && !parsed.plan) {
    parsed.plan =
      details.length > 0
        ? `${membership} ${details.join(" ")}`
        : String(membership);
  }
  if (profile.subscriptionStatus) {
    parsed.subscription_status = String(profile.subscriptionStatus);
  }
}

function mergeCursorUsage(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value === null || value === undefined) continue;
    if (target[key] === null || target[key] === undefined) {
      target[key] = value;
    }
  }
  return target;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toRoundedPercent(value) {
  const n = toFiniteNumber(value);
  return n === null ? null : Math.round(n);
}

function parseCursorUsage(data) {
  const result = {
    total_used_pct: null,
    auto_used_pct: null,
    composer_used: null,
    composer_limit: null,
    composer_used_pct: null,
    api_used: null,
    api_limit: null,
    api_used_pct: null,
    total_spend_cents: null,
    included_spend_cents: null,
    included_limit_cents: null,
    bonus_spend_cents: null,
    on_demand_limit_cents: null,
    on_demand_remaining_cents: null,
    on_demand_used_cents: null,
    monthly_resets: null,
    plan: null,
    subscription_status: null,
    auth_source: null,
  };

  if (!data || typeof data !== "object") {
    return result;
  }

  // DashboardService/GetCurrentPeriodUsage shape (matches Cursor Plan & Usage UI)
  if (data.planUsage && typeof data.planUsage === "object") {
    const planUsage = data.planUsage;
    result.total_used_pct = toRoundedPercent(planUsage.totalPercentUsed);
    result.auto_used_pct = toRoundedPercent(planUsage.autoPercentUsed);
    result.api_used_pct = toRoundedPercent(planUsage.apiPercentUsed);
    result.total_spend_cents = toFiniteNumber(planUsage.totalSpend);
    result.included_spend_cents = toFiniteNumber(planUsage.includedSpend);
    result.included_limit_cents = toFiniteNumber(planUsage.limit);
    result.bonus_spend_cents = toFiniteNumber(planUsage.bonusSpend);

    if (result.auto_used_pct != null && result.composer_used_pct == null) {
      result.composer_used_pct = result.auto_used_pct;
    }
  }

  if (data.spendLimitUsage && typeof data.spendLimitUsage === "object") {
    const spendLimitUsage = data.spendLimitUsage;
    result.on_demand_limit_cents = toFiniteNumber(spendLimitUsage.individualLimit);
    result.on_demand_remaining_cents = toFiniteNumber(
      spendLimitUsage.individualRemaining
    );
    if (
      result.on_demand_limit_cents != null &&
      result.on_demand_remaining_cents != null
    ) {
      result.on_demand_used_cents = Math.max(
        0,
        result.on_demand_limit_cents - result.on_demand_remaining_cents
      );
    }
  }

  if (data.billingCycleEnd) {
    const endEpochMs = Number(data.billingCycleEnd);
    if (Number.isFinite(endEpochMs) && endEpochMs > 0) {
      result.monthly_resets = formatResetDate(new Date(endEpochMs));
    }
  }

  // The Cursor usage API can return various structures
  // Common fields: numRequests, numRequestsTotal, maxRequestUsage, startOfMonth
  if (data["gpt-4"]) {
    const d = data["gpt-4"];
    result.composer_used = d.numRequests ?? d.numRequestsTotal ?? null;
    result.composer_limit = d.maxRequestUsage ?? null;
    if (result.composer_used != null && result.composer_limit != null && result.composer_limit > 0) {
      result.composer_used_pct = Math.round(
        (result.composer_used / result.composer_limit) * 100
      );
    }
  }

  // Check for premium/composer model usage
  if (data["claude-3.5-sonnet"] || data["claude-sonnet-4"] || data["premium"]) {
    const d = data["claude-3.5-sonnet"] || data["claude-sonnet-4"] || data["premium"];
    if (d.numRequests != null || d.numRequestsTotal != null) {
      result.composer_used = d.numRequests ?? d.numRequestsTotal ?? result.composer_used;
      result.composer_limit = d.maxRequestUsage ?? result.composer_limit;
      if (result.composer_used != null && result.composer_limit != null && result.composer_limit > 0) {
        result.composer_used_pct = Math.round(
          (result.composer_used / result.composer_limit) * 100
        );
      }
    }
  }

  // API usage (if separate)
  if (data.apiUsage || data.api) {
    const d = data.apiUsage || data.api;
    result.api_used = d.numRequests ?? d.used ?? null;
    result.api_limit = d.maxRequestUsage ?? d.limit ?? null;
    if (result.api_used != null && result.api_limit != null && result.api_limit > 0) {
      result.api_used_pct = Math.round(
        (result.api_used / result.api_limit) * 100
      );
    }
  }

  // Monthly reset
  if (data.startOfMonth) {
    const start = new Date(data.startOfMonth);
    const nextMonth = new Date(start);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    result.monthly_resets = formatResetDate(nextMonth);
  }

  // If we got raw data but our parsing didn't match, include it for debugging
  if (
    result.composer_used == null &&
    result.api_used == null &&
    result.total_used_pct == null &&
    Object.keys(data).length > 0
  ) {
    result._raw_keys = Object.keys(data);
    // Try to find any usage data generically
    for (const [key, val] of Object.entries(data)) {
      if (val && typeof val === "object" && val.numRequests != null) {
        if (!result.composer_used) {
          result.composer_used = val.numRequests;
          result.composer_limit = val.maxRequestUsage;
          result.composer_model = key;
          if (result.composer_limit > 0) {
            result.composer_used_pct = Math.round(
              (result.composer_used / result.composer_limit) * 100
            );
          }
        }
      }
    }
    if (data.startOfMonth) {
      const start = new Date(data.startOfMonth);
      const nextMonth = new Date(start);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      result.monthly_resets = formatResetDate(nextMonth);
    }
  }

  if (result.total_used_pct == null && result.composer_used_pct != null) {
    result.total_used_pct = result.composer_used_pct;
  }
  if (result.auto_used_pct == null && result.composer_used_pct != null) {
    result.auto_used_pct = result.composer_used_pct;
  }

  return result;
}

// ─── Shared utils ────────────────────────────────────────────────────────────
function formatResetDate(date) {
  const now = new Date();
  const diff = date - now;
  if (diff <= 0) return "now (or already reset)";

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  const datePart = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);

  return `${datePart} (${parts.join(" ")})`;
}

function formatUsdFromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return `$${(n / 100).toFixed(2)}`;
}

function formatElapsedSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return "";
  return `${DIM} (${n.toFixed(2)}s)${RESET}`;
}

// ─── Display ─────────────────────────────────────────────────────────────────
function displayClaude(data) {
  console.log(
    heading(
      `${MAGENTA}  Claude Code${RESET}${formatElapsedSeconds(data.elapsed_seconds)}`
    )
  );

  if (data.error) {
    console.log(`  ${RED}Error: ${data.error}${RESET}`);
    return;
  }

  console.log(
    sectionRow(
      "Session  ",
      data.session_used_pct,
      "Resets",
      data.session_resets ? formatClaudeReset(data.session_resets) : data.session_resets
    )
  );
  console.log(
    sectionRow(
      "Weekly   ",
      data.week_used_pct,
      "Resets",
      data.week_resets ? formatClaudeReset(data.week_resets) : data.week_resets
    )
  );

  if (data.extra_used_pct != null) {
    const spent =
      data.extra_spent_usd != null && data.extra_cap_usd != null
        ? ` ($${data.extra_spent_usd.toFixed(2)} / $${data.extra_cap_usd.toFixed(2)})`
        : "";
    console.log(
      sectionRow(
        `Extra    `,
        data.extra_used_pct,
        "Resets",
        data.extra_resets ? formatClaudeReset(data.extra_resets) : data.extra_resets
      )
    );
    if (spent) {
      console.log(`    ${DIM}Spend:${RESET}  ${CYAN}${spent.trim()}${RESET}`);
    }
  }
}

function displayCodex(data) {
  console.log(
    heading(
      `${GREEN}  Codex CLI${RESET}${formatElapsedSeconds(data.elapsed_seconds)}`
    )
  );

  if (data.error) {
    console.log(`  ${RED}Error: ${data.error}${RESET}`);
    console.log(
      `  ${DIM}Tip: Run ${CYAN}codex auth login${RESET}${DIM} to refresh CLI OAuth credentials${RESET}`
    );
    return;
  }

  if (data.plan) {
    console.log(`  ${DIM}Plan:${RESET} ${data.plan}`);
  }

  const primaryLabel = (data.primary_label || "Primary").padEnd(9, " ");
  const secondaryLabel = (data.secondary_label || "Secondary").padEnd(9, " ");
  const hasPrimary = data.primary_used_pct != null || data.primary_resets != null;
  const hasSecondary = data.secondary_used_pct != null || data.secondary_resets != null;

  if (hasPrimary) {
    console.log(
      sectionRow(
        primaryLabel,
        data.primary_used_pct,
        "Resets",
        data.primary_resets
      )
    );
  } else {
    console.log(
      sectionRow(
        "5-Hour   ",
        data.five_hour_used_pct,
        "Resets",
        data.five_hour_resets
      )
    );
  }

  if (hasSecondary) {
    console.log(
      sectionRow(
        secondaryLabel,
        data.secondary_used_pct,
        "Resets",
        data.secondary_resets
      )
    );
  } else {
    console.log(
      sectionRow(
        "Weekly   ",
        data.weekly_used_pct,
        "Resets",
        data.weekly_resets
      )
    );
  }

  if (data.credential_source) {
    console.log(
      `    ${DIM}Auth source:${RESET} ${CYAN}${data.credential_source}${RESET}`
    );
  }
}

function displayCursor(data) {
  console.log(
    heading(`${BLUE}  Cursor${RESET}${formatElapsedSeconds(data.elapsed_seconds)}`)
  );

  if (data.error) {
    console.log(`  ${RED}Error: ${data.error}${RESET}`);
    return;
  }

  if (data.plan) {
    const status = data.subscription_status
      ? ` (${data.subscription_status})`
      : "";
    console.log(`  ${DIM}Plan:${RESET} ${data.plan}${status}`);
  }

  if (data.auth_source) {
    console.log(
      `  ${DIM}Auth source:${RESET} ${CYAN}${data.auth_source}${RESET}`
    );
  }

  const totalPct = data.total_used_pct ?? data.composer_used_pct;
  const autoPct = data.auto_used_pct ?? data.composer_used_pct;

  console.log(
    sectionRow(
      "Total    ",
      totalPct,
      "Monthly reset",
      data.monthly_resets
    )
  );

  if (autoPct != null) {
    console.log(
      sectionRow("Auto     ", autoPct, "Monthly reset", data.monthly_resets)
    );
  }

  if (data.api_used_pct != null || data.api_used != null || data.api_limit != null) {
    const apiDetail =
      data.api_used != null && data.api_limit != null
        ? ` (${data.api_used} / ${data.api_limit} requests)`
        : "";
    console.log(
      sectionRow(
        "API      ",
        data.api_used_pct,
        "Monthly reset",
        data.monthly_resets
      )
    );
    if (apiDetail) {
      console.log(`    ${DIM}Requests:${RESET}${apiDetail}`);
    }
  }

  const includedUsed = formatUsdFromCents(data.included_spend_cents);
  const includedLimit = formatUsdFromCents(data.included_limit_cents);
  if (includedUsed || includedLimit) {
    console.log(
      `    ${DIM}Included:${RESET} ${includedUsed || "?"} / ${includedLimit || "?"}`
    );
  }

  const bonusSpend = formatUsdFromCents(data.bonus_spend_cents);
  if (bonusSpend && Number(data.bonus_spend_cents) > 0) {
    console.log(`    ${DIM}Bonus:${RESET} ${bonusSpend}`);
  }

  const onDemandUsed = formatUsdFromCents(data.on_demand_used_cents);
  const onDemandLimit = formatUsdFromCents(data.on_demand_limit_cents);
  if (onDemandUsed || onDemandLimit) {
    console.log(
      `    ${DIM}On-demand:${RESET} ${onDemandUsed || "?"} / ${onDemandLimit || "?"}`
    );
  }
}

// ─── Setup wizard ────────────────────────────────────────────────────────────
async function setup() {
  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  const config = loadConfig();

  console.log(`\n${BOLD}AI Agent Usage Monitor - Setup${RESET}\n`);

  // Claude
  console.log(
    `${MAGENTA}${BOLD}Claude Code${RESET} uses the expect script (no config needed).`
  );
  console.log(
    `  Make sure you've run ${CYAN}claude auth login${RESET} in a standalone terminal.\n`
  );

  // Codex
  console.log(`${GREEN}${BOLD}Codex${RESET}`);
  console.log(
    `  Uses Codex CLI OAuth credentials from your local Codex auth store/keychain.`
  );
  console.log(
    `  Run ${CYAN}codex auth login${RESET} in a standalone terminal if usage fails.\n`
  );
  delete config.codex_cookies;

  // Cursor
  console.log(`\n${BLUE}${BOLD}Cursor${RESET}`);
  console.log(
    `  Uses Cursor desktop auth from local Cursor state (no cookie copy required).`
  );
  console.log(
    `  Make sure you are signed in to Cursor.\n`
  );
  const cursorToken = await ask(
    `  Optional: paste Cursor access token override (or press Enter to auto-detect): `
  );
  if (cursorToken.trim()) {
    config.cursor_access_token = cursorToken.trim();
  }
  delete config.cursor_session_token;

  saveConfig(config);
  console.log(`\n${GREEN}Config saved to ${CONFIG_PATH}${RESET}\n`);
  rl.close();
}

// ─── JSON mode ───────────────────────────────────────────────────────────────
function outputJson(claude, codex, cursor) {
  const result = {};
  if (claude) result.claude = claude;
  if (codex) result.codex = codex;
  if (cursor) result.cursor = cursor;
  console.log(JSON.stringify(result, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
${BOLD}AI Agent Usage Monitor${RESET}

${DIM}Usage:${RESET}
  node usage.js              Show usage for all configured services
  node usage.js --claude     Show Claude Code usage only
  node usage.js --codex      Show Codex usage only
  node usage.js --cursor     Show Cursor usage only
  node usage.js --json       Output as JSON
  node usage.js --setup      Configure API tokens
  node usage.js --help       Show this help

${DIM}Services:${RESET}
  Claude Code   Uses expect to run /usage in the CLI (requires claude auth login)
  Codex         Fetches wham usage using Codex CLI OAuth (requires codex auth login)
  Cursor        Fetches Plan & Usage via api2.cursor.sh DashboardService using Cursor desktop auth (or CURSOR_ACCESS_TOKEN)

${DIM}Env overrides:${RESET}
  CLAUDE_USAGE_TIMEOUT_MS  Override Claude collector timeout (default 35000, range 5000-120000)
  CLAUDE_USAGE_DEBUG=1     On Claude error, write full output to .claude-usage-debug.txt
`);
    return;
  }

  if (args.includes("--setup")) {
    await setup();
    return;
  }

  const config = loadConfig();
  const jsonMode = args.includes("--json");
  const claudeOnly = args.includes("--claude");
  const codexOnly = args.includes("--codex");
  const cursorOnly = args.includes("--cursor");
  const showAll = !claudeOnly && !codexOnly && !cursorOnly;

  if (!jsonMode) {
    console.log(`\n${BOLD}${WHITE}  AI Agent Usage Monitor${RESET}`);
    console.log(`  ${DIM}${new Date().toLocaleString()}${RESET}`);
  }

  // Run fetches in parallel
  const promises = {};
  const startedAtMs = {};

  if (showAll || claudeOnly) {
    startedAtMs.claude = Date.now();
    promises.claude = fetchClaudeUsage();
  }
  if (showAll || codexOnly) {
    startedAtMs.codex = Date.now();
    promises.codex = fetchCodexUsage();
  }
  if (showAll || cursorOnly) {
    startedAtMs.cursor = Date.now();
    promises.cursor = fetchCursorUsage(config);
  }

  const keys = Object.keys(promises);
  const values = await Promise.all(Object.values(promises));
  const results = {};
  keys.forEach((k, i) => {
    const elapsedSeconds = Number(
      ((Date.now() - (startedAtMs[k] || Date.now())) / 1000).toFixed(2)
    );
    const value = values[i];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      results[k] = { ...value, elapsed_seconds: elapsedSeconds };
    } else {
      results[k] = { value, elapsed_seconds: elapsedSeconds };
    }
  });

  if (jsonMode) {
    outputJson(results.claude, results.codex, results.cursor);
    return;
  }

  if (results.claude) displayClaude(results.claude);
  if (results.codex) displayCodex(results.codex);
  if (results.cursor) displayCursor(results.cursor);

  console.log(`\n${DIM}${"─".repeat(60)}${RESET}\n`);
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
