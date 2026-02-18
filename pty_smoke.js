const pty = require("node-pty");

const term = pty.spawn("/bin/zsh", ["-lc", "echo OK; exit"], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

term.onData((d) => process.stdout.write(d));
term.onExit(({ exitCode, signal }) => {
  console.log("\nexit", { exitCode, signal });
});
