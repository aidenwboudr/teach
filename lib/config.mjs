// The `teach` command's settings: ~/.config/teach/env (TEACH_CONFIG names another file; /dev/null turns it off),
// KEY=VALUE lines that fill in what the environment doesn't set. Import it before lib/paths.mjs. The server
// never loads it: systemd hands the service the same file (EnvironmentFile), and a dev or test server started
// by hand must not pick up the live socket or sync settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
export function loadConfig(file = process.env.TEACH_CONFIG || path.join(HOME, ".config/teach/env")) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v;   // (lib/paths.mjs expands ~, $HOME, %h and %t)
  }
}
loadConfig();
