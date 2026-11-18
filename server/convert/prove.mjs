#!/usr/bin/env node
// The converter's network proof, run by deploy/convert.sh against the converter it just started (and by hand:
// `node server/convert/prove.mjs [http://127.0.0.1:8318]`). Proof, not assumption (bloom's AGENTS.md, the 401 lesson):
//   1. a listener on this Mac, and a probe outside the sandbox that reaches it (the listener works: one connection);
//   2. the same probe under the converter's own profile: refused by the operating system (EPERM), the listener sees
//      nothing more;
//   3. a Word document whose picture is linked to that listener, converted by the running converter, while every
//      50 ms `lsof` lists the internet sockets of every LibreOffice process of the converter's jobs and `nettop` their
//      connections: none may appear, and the listener must still have seen only the first probe.
// Prints what it saw; exits 1 if anything reached the network.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { linkedPictureDocx } from "./probe-files.mjs";
import { profile } from "./convert_server.mjs";

const base = (process.argv[2] || "http://127.0.0.1:8318").replace(/\/$/, "");
const seen = [];
const listener = createServer((s) => { seen.push(new Date().toISOString()); s.destroy(); });
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
const PROBE = `const s=require("node:net").connect(${port},"127.0.0.1");s.on("error",e=>{console.log(e.code);process.exit(0)});s.on("connect",()=>{console.log("CONNECTED");s.destroy();process.exit(0)});setTimeout(()=>{console.log("TIMEOUT");process.exit(0)},3000);`;
let failed = false;
const say = (ok, line) => { console.log(`${ok ? "  ✓" : "  ✗"} ${line}`); if (!ok) failed = true; };

// 1 and 2: the listener works, and the profile denies the same connection
const outside = spawnSync(process.execPath, ["-e", PROBE], { encoding: "utf8" }).stdout.trim();
await new Promise((r) => setTimeout(r, 200));
say(outside === "CONNECTED" && seen.length === 1, `outside the sandbox a probe reaches the listener on 127.0.0.1:${port} (${outside}; the listener saw ${seen.length})`);
const jobs = join(homedir(), ".mux", "convert", "jobs");
mkdirSync(jobs, { recursive: true });
const dir = mkdtempSync(join(jobs, "prove-"));
const inside = spawnSync("/usr/bin/sandbox-exec", ["-p", profile(dir), process.execPath, "-e", PROBE], { encoding: "utf8", cwd: dir }).stdout.trim();
rmSync(dir, { recursive: true, force: true });
await new Promise((r) => setTimeout(r, 200));
say(["EPERM", "EACCES"].includes(inside) && seen.length === 1, `under the converter's profile the same probe is refused by the OS (${inside}); the listener still saw ${seen.length}`);

// 3: a real conversion of a document that links its picture to the listener, watched with lsof and nettop
const watched = { lsof: new Set(), nettop: new Set(), pids: new Set() };
const ours = () => {
  try {
    return execFileSync("/usr/bin/pgrep", ["-f", ".mux/convert/jobs/job-"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { return []; }
};
let watching = true;
const watch = (async () => {
  while (watching) {
    for (const pid of ours()) {
      watched.pids.add(pid);
      try {
        const l = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", pid, "-i"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        for (const line of l.split("\n").slice(1).filter(Boolean)) watched.lsof.add(line.trim());
      } catch { /* none: lsof exits 1 when a process has no internet sockets */ }
      try {
        const n = execFileSync("/usr/bin/nettop", ["-P", "-L", "1", "-n", "-x", "-p", pid], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
        for (const line of n.split("\n").slice(1).filter((x) => /tcp|udp/i.test(x))) watched.nettop.add(line.trim());
      } catch { /* gone */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
})();
const t0 = Date.now();
const r = await fetch(`${base}/v1/convert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_b64: linkedPictureDocx(`http://127.0.0.1:${port}/pic.png`).toString("base64") }) });
const j = await r.json();
watching = false;
await watch;
await new Promise((r) => setTimeout(r, 300));
say(r.status === 200 && typeof j.pdf_b64 === "string", `the linked-picture document became a PDF (${r.status}, ${j.bytes ?? "-"} bytes, ${Date.now() - t0} ms${j.error ? `, ${j.error.type}: ${j.error.message}` : ""})`);
say(watched.pids.size > 0, `LibreOffice processes of the job watched: ${[...watched.pids].join(", ") || "none seen (the job was too quick to watch)"}`);
say(watched.lsof.size === 0, `lsof: ${watched.lsof.size} internet sockets on them${watched.lsof.size ? `: ${[...watched.lsof].join(" | ")}` : ""}`);
say(watched.nettop.size === 0, `nettop: ${watched.nettop.size} connections from them${watched.nettop.size ? `: ${[...watched.nettop].join(" | ")}` : ""}`);
say(seen.length === 1, `the listener the document points at saw ${seen.length - 1} connections from the conversion`);
listener.close();
console.log(failed ? "✗ the network proof did not pass" : "✓ the network proof passed: nothing of the conversion reached the network");
process.exit(failed ? 1 : 0);
