#!/usr/bin/env node
const { spawn } = require("node:child_process");

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function parseUsage(text) {
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
      if (normalize(lines[i]).includes(token)) {
        return i;
      }
    }
    return -1;
  };

  const readSection = (idx) => {
    if (idx < 0) {
      return { pct: null, reset: null };
    }

    const window = lines.slice(idx, idx + 12);
    let pct = null;
    for (const line of window) {
      const m = line.match(/(\d{1,3})%\s*used/i);
      if (m) {
        pct = Number(m[1]);
        break;
      }
    }

    let reset = null;
    const resetLine = window.find((line) => /rese/i.test(normalize(line)));
    if (resetLine) {
      reset = resetLine
        .replace(/.*rese(?:ts?|s)\s*/i, "")
        .replace(/^[.\-:·]+\s*/, "")
        .trim();
      if (!reset) {
        reset = null;
      }
    }

    return { pct, reset };
  };

  const session = readSection(findSectionIndex("currentsession"));
  const week = readSection(findSectionIndex("currentweek"));
  const extra = readSection(findSectionIndex("extrausage"));

  const compact = clean.replace(/\s+/g, "");
  const moneyMatch = compact.match(/\$([0-9]+\.[0-9]{2})\/\$([0-9]+\.[0-9]{2})spent/i);
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

const child = spawn("./claude_usage.expect", [], {
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
let err = "";

child.stdout.on("data", (d) => (out += d.toString("utf8")));
child.stderr.on("data", (d) => (err += d.toString("utf8")));

child.on("exit", (code) => {
  if (code !== 0) {
    process.stderr.write(err || "");
    process.stderr.write("\nFailed running claude_usage.expect\n");
    process.exit(code ?? 1);
  }

  const parsed = parseUsage(out);
  process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
  process.exit(0);
});
