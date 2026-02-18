#!/usr/bin/env node
const { spawn, execSync } = require("node:child_process");
const https = require("node:https");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

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

function heading(text) {
  const line = "─".repeat(60);
  return `\n${DIM}${line}${RESET}\n${BOLD}${text}${RESET}\n${DIM}${line}${RESET}`;
}

function sectionRow(label, pctOrValue, resetLabel, resetValue) {
  const pctStr =
    typeof pctOrValue === "number" ? progressBar(pctOrValue) : pctOrValue;
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

    const child = spawn(expectScript, [], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 45000);

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.includes("Current session")) {
        resolve({
          error: `expect script exited ${code}: ${err.slice(0, 200)}`,
        });
        return;
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

// ─── Codex: fetch via web dashboard scrape ───────────────────────────────────
function fetchCodexUsage(config) {
  return new Promise((resolve) => {
    const cookies = config.codex_cookies;
    if (!cookies) {
      resolve({
        error:
          "No Codex cookies configured. Run with --setup to configure, or set codex_cookies in .usage-config.json",
      });
      return;
    }

    const options = {
      hostname: "chatgpt.com",
      path: "/backend-api/codex/rate_limits",
      method: "GET",
      headers: {
        Cookie: cookies,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          // Try alternate endpoint
          fetchCodexUsageFallback(config).then(resolve);
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve(parseCodexRateLimits(data));
        } catch (e) {
          fetchCodexUsageFallback(config).then(resolve);
        }
      });
    });
    req.on("error", () => fetchCodexUsageFallback(config).then(resolve));
    req.setTimeout(10000, () => {
      req.destroy();
      fetchCodexUsageFallback(config).then(resolve);
    });
    req.end();
  });
}

function fetchCodexUsageFallback(config) {
  return new Promise((resolve) => {
    const cookies = config.codex_cookies;
    const options = {
      hostname: "chatgpt.com",
      path: "/backend-api/accounts/check/v4-2023-04-27",
      method: "GET",
      headers: {
        Cookie: cookies,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve({
            error: `Codex API returned ${res.statusCode}. Cookies may have expired. Run with --setup to reconfigure.`,
          });
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve(parseCodexAccountCheck(data));
        } catch (e) {
          resolve({ error: `Failed to parse Codex response: ${e.message}` });
        }
      });
    });
    req.on("error", (e) =>
      resolve({ error: `Codex request failed: ${e.message}` })
    );
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ error: "Codex request timed out" });
    });
    req.end();
  });
}

function parseCodexRateLimits(data) {
  // The rate_limits endpoint returns structured data about 5h and weekly limits
  const result = {
    five_hour_used_pct: null,
    five_hour_resets: null,
    weekly_used_pct: null,
    weekly_resets: null,
  };

  if (data && data.rate_limits) {
    for (const limit of data.rate_limits) {
      const windowHours = limit.window_seconds
        ? limit.window_seconds / 3600
        : null;
      const pct =
        limit.max_usage > 0
          ? Math.round((limit.current_usage / limit.max_usage) * 100)
          : null;
      const resetAt = limit.reset_at
        ? formatResetDate(new Date(limit.reset_at * 1000))
        : null;

      if (windowHours && windowHours <= 6) {
        result.five_hour_used_pct = pct;
        result.five_hour_resets = resetAt;
      } else if (windowHours && windowHours >= 24 * 6) {
        result.weekly_used_pct = pct;
        result.weekly_resets = resetAt;
      }
    }
  }
  return result;
}

function parseCodexAccountCheck(data) {
  // Fallback: extract what we can from the account check endpoint
  const result = {
    five_hour_used_pct: null,
    five_hour_resets: null,
    weekly_used_pct: null,
    weekly_resets: null,
    plan: null,
  };

  if (data?.accounts?.default?.plan_type) {
    result.plan = data.accounts.default.plan_type;
  }

  // Look for rate limit info in various nested structures
  const rl = data?.accounts?.default?.rate_limits;
  if (rl) {
    for (const [key, val] of Object.entries(rl)) {
      if (key.includes("codex") || key.includes("5h") || key.includes("hour")) {
        if (val.remaining != null && val.limit != null) {
          result.five_hour_used_pct = Math.round(
            ((val.limit - val.remaining) / val.limit) * 100
          );
        }
        if (val.reset_at) {
          result.five_hour_resets = formatResetDate(
            new Date(val.reset_at * 1000)
          );
        }
      }
      if (key.includes("week")) {
        if (val.remaining != null && val.limit != null) {
          result.weekly_used_pct = Math.round(
            ((val.limit - val.remaining) / val.limit) * 100
          );
        }
        if (val.reset_at) {
          result.weekly_resets = formatResetDate(
            new Date(val.reset_at * 1000)
          );
        }
      }
    }
  }

  return result;
}

// ─── Cursor: fetch via API ───────────────────────────────────────────────────
function fetchCursorUsage(config) {
  return new Promise((resolve) => {
    const token = config.cursor_session_token;
    if (!token) {
      resolve({
        error:
          "No Cursor session token configured. Run with --setup to configure.",
      });
      return;
    }

    // First get user ID
    const authOptions = {
      hostname: "www.cursor.com",
      path: "/api/auth/me",
      method: "GET",
      headers: {
        Cookie: `WorkosCursorSessionToken=${token}`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json",
      },
    };

    const req = https.request(authOptions, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve({
            error: `Cursor auth returned ${res.statusCode}. Token may have expired. Run with --setup to reconfigure.`,
          });
          return;
        }
        try {
          const authData = JSON.parse(body);
          const userId =
            authData.id || authData.sub || authData.user_id || authData.email;
          if (!userId) {
            resolve({ error: "Could not determine Cursor user ID" });
            return;
          }
          fetchCursorUsageData(token, userId).then(resolve);
        } catch (e) {
          resolve({ error: `Failed to parse Cursor auth: ${e.message}` });
        }
      });
    });
    req.on("error", (e) =>
      resolve({ error: `Cursor auth request failed: ${e.message}` })
    );
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ error: "Cursor auth request timed out" });
    });
    req.end();
  });
}

function fetchCursorUsageData(token, userId) {
  return new Promise((resolve) => {
    const options = {
      hostname: "www.cursor.com",
      path: `/api/usage?user=${encodeURIComponent(userId)}`,
      method: "GET",
      headers: {
        Cookie: `WorkosCursorSessionToken=${token}`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve({
            error: `Cursor usage API returned ${res.statusCode}`,
          });
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve(parseCursorUsage(data));
        } catch (e) {
          resolve({ error: `Failed to parse Cursor usage: ${e.message}` });
        }
      });
    });
    req.on("error", (e) =>
      resolve({ error: `Cursor usage request failed: ${e.message}` })
    );
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ error: "Cursor usage request timed out" });
    });
    req.end();
  });
}

function parseCursorUsage(data) {
  const result = {
    composer_used: null,
    composer_limit: null,
    composer_used_pct: null,
    api_used: null,
    api_limit: null,
    api_used_pct: null,
    monthly_resets: null,
  };

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

// ─── Display ─────────────────────────────────────────────────────────────────
function displayClaude(data) {
  console.log(heading(`${MAGENTA}  Claude Code${RESET}`));

  if (data.error) {
    console.log(`  ${RED}Error: ${data.error}${RESET}`);
    return;
  }

  console.log(
    sectionRow(
      "Session  ",
      data.session_used_pct,
      "Resets",
      data.session_resets
    )
  );
  console.log(
    sectionRow("Weekly   ", data.week_used_pct, "Resets", data.week_resets)
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
        data.extra_resets
      )
    );
    if (spent) {
      console.log(`    ${DIM}Spend:${RESET}  ${CYAN}${spent.trim()}${RESET}`);
    }
  }
}

function displayCodex(data) {
  console.log(heading(`${GREEN}  Codex CLI${RESET}`));

  if (data.error) {
    console.log(`  ${RED}Error: ${data.error}${RESET}`);
    console.log(
      `  ${DIM}Tip: Run /status inside an interactive Codex session to see usage${RESET}`
    );
    return;
  }

  if (data.plan) {
    console.log(`  ${DIM}Plan:${RESET} ${data.plan}`);
  }

  console.log(
    sectionRow(
      "5-Hour   ",
      data.five_hour_used_pct,
      "Resets",
      data.five_hour_resets
    )
  );
  console.log(
    sectionRow(
      "Weekly   ",
      data.weekly_used_pct,
      "Resets",
      data.weekly_resets
    )
  );
}

function displayCursor(data) {
  console.log(heading(`${BLUE}  Cursor${RESET}`));

  if (data.error) {
    console.log(`  ${RED}Error: ${data.error}${RESET}`);
    return;
  }

  const composerLabel = data.composer_model
    ? `Composer (${data.composer_model})`
    : "Composer ";

  const composerDetail =
    data.composer_used != null && data.composer_limit != null
      ? ` (${data.composer_used} / ${data.composer_limit} requests)`
      : "";

  console.log(
    sectionRow(
      composerLabel,
      data.composer_used_pct,
      "Monthly reset",
      data.monthly_resets
    )
  );
  if (composerDetail) {
    console.log(`    ${DIM}Requests:${RESET}${composerDetail}`);
  }

  if (data.api_used_pct != null || data.api_used != null) {
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
  console.log(`  To get your session cookies:`);
  console.log(`  1. Open ${CYAN}https://chatgpt.com/codex/settings/usage${RESET} in your browser`);
  console.log(`  2. Open DevTools (F12) > Application > Cookies > chatgpt.com`);
  console.log(
    `  3. Copy the full cookie string (or at minimum the session token)\n`
  );
  const codexCookies = await ask(
    `  Paste Codex cookies (or press Enter to skip): `
  );
  if (codexCookies.trim()) {
    config.codex_cookies = codexCookies.trim();
  }

  // Cursor
  console.log(`\n${BLUE}${BOLD}Cursor${RESET}`);
  console.log(`  To get your session token:`);
  console.log(`  1. Open ${CYAN}https://www.cursor.com${RESET} in your browser (logged in)`);
  console.log(
    `  2. Open DevTools (F12) > Application > Cookies > cursor.com`
  );
  console.log(
    `  3. Copy the value of ${CYAN}WorkosCursorSessionToken${RESET}\n`
  );
  const cursorToken = await ask(
    `  Paste Cursor session token (or press Enter to skip): `
  );
  if (cursorToken.trim()) {
    config.cursor_session_token = cursorToken.trim();
  }

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
  node usage.js --setup      Configure API tokens/cookies
  node usage.js --help       Show this help

${DIM}Services:${RESET}
  Claude Code   Uses expect to run /usage in the CLI (requires claude auth login)
  Codex         Fetches from chatgpt.com API (requires session cookies)
  Cursor        Fetches from cursor.com API (requires WorkosCursorSessionToken)
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

  if (showAll || claudeOnly) {
    promises.claude = fetchClaudeUsage();
  }
  if (showAll || codexOnly) {
    promises.codex = fetchCodexUsage(config);
  }
  if (showAll || cursorOnly) {
    promises.cursor = fetchCursorUsage(config);
  }

  const keys = Object.keys(promises);
  const values = await Promise.all(Object.values(promises));
  const results = {};
  keys.forEach((k, i) => (results[k] = values[i]));

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
