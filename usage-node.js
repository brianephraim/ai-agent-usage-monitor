#!/usr/bin/env node
const { spawn } = require("node:child_process");

const child = spawn("./claude_usage.expect", [], { stdio: "inherit" });

child.on("exit", (code) => process.exit(code ?? 1));
