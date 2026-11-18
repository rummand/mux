#!/usr/bin/env node
// The document converter on the Mac (route `convert`, kind `document`): a Word, PowerPoint, Excel or OpenDocument file
// in, a PDF out, drawn by LibreOffice headless. bloom for business draws a Word or PowerPoint file's pages on its Desk
// from this PDF (the owner, 19 November 2026: "a small converter service on the Mac Studio, reached through Mux like
// the other models, with its network cut off and a time limit. No change to the production image.").
//
// Why the operating system and not a setting: LibreOffice 7.4 fetched a document's linked picture over the network
// while converting (bloom's desk-files journal, 18 November 2026). A setting can be wrong for one file kind or change
// with a version; a sandbox cannot be talked out of. Every conversion runs under macOS sandbox-exec with this profile:
//   - every IP connection, bind and listen denied (local Unix sockets stay: LibreOffice's own pipe needs one);
//   - the name resolver's socket (/private/var/run/mDNSResponder) denied, so a document cannot even look a name up;
//   - nothing read from the user's home (keys and tokens live in ~/.mux, ~/.bloom), /private/tmp or /Volumes but the
//     job's own folder; nothing written there, nor into /Applications, /Library, /usr/local or /opt;
// and the denial is proven, not assumed: at start and every 10 minutes a probe under the same profile must be refused
// a TCP connection to a listener this server opens (the listener must see nothing), the resolver's socket and a file
// in the home folder. Until the probe passes, every job is refused (503 sandbox_unproven): there is no switch to run
// without it.
//
// Per job: one fresh folder (the file, the PDF, a LibreOffice profile of its own, its temporary folder) under
// ~/.mux/convert/jobs, deleted when the job ends, whatever happened; a hard time limit (30 s), after which the whole
// process group is killed; a size cap (25 MB); macros never run (the job's profile turns macro execution off, sets the
// highest macro security, turns off active content and recalculation on load). The file is never logged.
//
// Contract (what mux's router/convert.ts passes on):
//   POST /v1/convert {model?, file_b64, filename?}  →  200 {object: "conversion", model, input, format: "pdf",
//                                                          bytes, sha256, ms, pdf_b64}
//   400 invalid_request · 413 file_too_large · 415 unsupported_type · 422 conversion_failed | conversion_timeout
//   429 busy · 503 sandbox_unproven | converter_missing
//   GET /v1/models → {data: [{id, loaded: true}]}; GET /health → {ok, sandbox, soffice}
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer as createTcpServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
export const config = {
  port: Number(env.MUX_CONVERT_PORT || 8318),
  model: env.MUX_CONVERT_MODEL || "libreoffice",
  soffice: env.MUX_CONVERT_SOFFICE || "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  timeoutMs: Number(env.MUX_CONVERT_TIMEOUT_S || 30) * 1000,
  maxBytes: Number(env.MUX_CONVERT_MAX_MB || 25) * 1024 * 1024,
  parallel: Math.max(1, Number(env.MUX_CONVERT_PARALLEL || 2)),
  queue: Math.max(0, Number(env.MUX_CONVERT_QUEUE || 6)),
  home: env.MUX_CONVERT_HOME_TO_DENY || homedir(),
  jobs: env.MUX_CONVERT_JOBS || join(homedir(), ".mux", "convert", "jobs"),
};

const q = (s) => JSON.stringify(s);
/** The sandbox matches real paths: /var/folders is /private/var/folders to it, and a symlinked home its target. */
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

/** The sandbox profile for one job's folder (see the head of this file). Both paths are taken as their real paths. */
export function profile(jobPath, homePath = config.home) {
  const job = real(jobPath), home = real(homePath);
  return [
    "(version 1)",
    "(allow default)",
    // The network: no IP at all; the resolver's socket too. Unix sockets otherwise stay (LibreOffice's own pipe).
    "(deny network-outbound (remote ip))",
    "(deny network-inbound (local ip))",
    "(deny network-bind (local ip))",
    '(deny network-outbound (literal "/private/var/run/mDNSResponder"))',
    // Files: nothing of the home folder, /private/tmp or other volumes is read or written ...
    `(deny file-read-data file-write* (subpath ${q(home)}) (subpath "/private/tmp") (subpath "/Volumes"))`,
    '(deny file-write* (subpath "/Applications") (subpath "/Library") (subpath "/usr/local") (subpath "/opt"))',
    // ... but the job's own folder, and LibreOffice's pipe in /tmp. (A rule that allows must name the same operations
    // as the one it overrides: file-read-data, not file-read*.)
    `(allow file-read-data file-write* (subpath ${q(job)}) (regex #"^/private/tmp/OSL_PIPE_"))`,
  ].join("");
}

// LibreOffice's settings for one job: macros never run, no active content, nothing recalculated on load.
const XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>1</value></prop></item>
</oor:items>
`;

/** The names in a ZIP's central directory (for telling Office files apart by what they hold, never by their name). */
export function zipNames(bytes) {
  const min = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes.readUInt32LE(i) !== 0x06054b50) continue;
    const count = bytes.readUInt16LE(i + 10), size = bytes.readUInt32LE(i + 12), at = bytes.readUInt32LE(i + 16);
    if (at + size > bytes.length) return null;
    const names = [];
    for (let p = at, n = 0; n < count && p + 46 <= bytes.length; n++) {
      if (bytes.readUInt32LE(p) !== 0x02014b50) return null;
      const len = bytes.readUInt16LE(p + 28), extra = bytes.readUInt16LE(p + 30), comment = bytes.readUInt16LE(p + 32);
      names.push(bytes.subarray(p + 46, p + 46 + len).toString("utf8"));
      p += 46 + len + extra + comment;
    }
    return names;
  }
  return null;
}

const ODF = { "application/vnd.oasis.opendocument.text": "odt", "application/vnd.oasis.opendocument.presentation": "odp", "application/vnd.oasis.opendocument.spreadsheet": "ods" };

/** What a file is, by its bytes: docx, pptx, xlsx, odt, odp or ods; null for anything else. */
export function sniff(bytes) {
  if (bytes.length < 30 || bytes.readUInt32LE(0) !== 0x04034b50) return null;
  // OpenDocument: a first entry "mimetype", stored, holding the type.
  const nameLen = bytes.readUInt16LE(26), extraLen = bytes.readUInt16LE(28);
  if (bytes.subarray(30, 30 + nameLen).toString("latin1") === "mimetype" && bytes.readUInt16LE(8) === 0) {
    const size = bytes.readUInt32LE(18);
    const mime = bytes.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + Math.min(size, 100)).toString("latin1");
    if (ODF[mime]) return ODF[mime];
  }
  const names = new Set(zipNames(bytes) || []);
  if (!names.has("[Content_Types].xml")) return null;
  if (names.has("word/document.xml")) return "docx";
  if (names.has("ppt/presentation.xml")) return "pptx";
  if (names.has("xl/workbook.xml")) return "xlsx";
  return null;
}

class Refusal extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}

// ---------------------------------------------------------------------------------------------- the sandbox, proven

const PROBE = `
const net = require("node:net"), fs = require("node:fs");
const out = {};
const tcp = () => new Promise((r) => { const s = net.connect(Number(process.argv[1]), "127.0.0.1"); s.on("error", (e) => r(e.code)); s.on("connect", () => { s.destroy(); r("CONNECTED"); }); setTimeout(() => r("TIMEOUT"), 3000); });
const dns = () => new Promise((r) => { const s = net.connect("/private/var/run/mDNSResponder"); s.on("error", (e) => r(e.code)); s.on("connect", () => { s.destroy(); r("CONNECTED"); }); setTimeout(() => r("TIMEOUT"), 3000); });
(async () => {
  out.tcp = await tcp();
  out.dns = await dns();
  try { fs.readFileSync(process.argv[2]); out.home = "READ"; } catch (e) { out.home = e.code; }
  try { fs.writeFileSync(process.argv[3] + "/ok", "1"); out.job = "WRITTEN"; } catch (e) { out.job = e.code; }
  console.log(JSON.stringify(out));
})();`;
const DENIED = new Set(["EPERM", "EACCES", "ENETUNREACH", "EADDRNOTAVAIL"]);

let proof = { proven: false, at: 0, says: "not proven yet" };

/**
 * Prove the profile holds on this machine: a probe under it is refused a TCP connection to a listener opened here (and
 * the listener sees no connection), the resolver's socket, and a file in the home folder, and may write in its own
 * folder. Kept for 10 minutes.
 */
export async function proveSandbox(force = false) {
  if (!force && proof.proven && Date.now() - proof.at < 600_000) return proof;
  if (!existsSync("/usr/bin/sandbox-exec")) return (proof = { proven: false, at: Date.now(), says: "this machine has no sandbox-exec: nothing is converted" });
  mkdirSync(config.jobs, { recursive: true, mode: 0o700 });
  const dir = join(config.jobs, `probe-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { mode: 0o700 });
  const canaryDir = join(config.home, ".mux", "convert");
  mkdirSync(canaryDir, { recursive: true, mode: 0o700 });
  const canary = join(canaryDir, "canary");
  writeFileSync(canary, "the converter's sandbox must not read this\n", { mode: 0o600 });
  let reached = 0;
  const listener = createTcpServer((s) => { reached++; s.destroy(); });
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  try {
    const port = listener.address().port;
    const got = await run("/usr/bin/sandbox-exec", ["-p", profile(dir), process.execPath, "-e", PROBE, String(port), canary, dir], { cwd: dir, timeoutMs: 15_000 });
    let r = {};
    try { r = JSON.parse(got.stdout.trim().split("\n").pop() || "{}"); } catch { /* no answer */ }
    const ok = DENIED.has(r.tcp) && DENIED.has(r.dns) && DENIED.has(r.home) && r.job === "WRITTEN" && reached === 0;
    proof = {
      proven: ok, at: Date.now(),
      says: ok ? `denied by macOS sandbox-exec: TCP ${r.tcp}, resolver ${r.dns}, home ${r.home}; the listener saw ${reached} connections; the job's folder is writable`
        : `the sandbox did not hold: TCP ${r.tcp ?? "?"}, resolver ${r.dns ?? "?"}, home ${r.home ?? "?"}, job ${r.job ?? "?"}, listener saw ${reached} (${got.stderr.slice(0, 200)})`,
    };
    return proof;
  } finally {
    listener.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a program in its own process group; past the limit the whole group is killed. */
function run(cmd, args, { cwd, timeoutMs, env: childEnv }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv ?? { PATH: "/usr/bin:/bin" } });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => { if (stdout.length < 65536) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 65536) stderr += d; });
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: String(e.message), timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); kill(); resolve({ code, stdout, stderr, timedOut }); });
  });
}

// ---------------------------------------------------------------------------------------------- one conversion

let running = 0;
const waiting = [];
async function slot() {
  if (running < config.parallel) { running++; return; }
  if (waiting.length >= config.queue) throw new Refusal(429, "busy", `the converter is busy (${config.parallel} at once, ${config.queue} waiting); ask again shortly`);
  await new Promise((r) => waiting.push(r));
  running++;
}
function free() {
  running--;
  waiting.shift()?.();
}

/** Convert one file to PDF in a fresh sandboxed job. */
export async function convert(bytes) {
  if (bytes.length > config.maxBytes) throw new Refusal(413, "file_too_large", `the file is ${bytes.length} bytes; at most ${config.maxBytes} are converted`);
  const kind = sniff(bytes);
  if (!kind) throw new Refusal(415, "unsupported_type", "only Word (docx), PowerPoint (pptx), Excel (xlsx) and OpenDocument (odt, odp, ods) files are converted, known by their bytes");
  if (!existsSync(config.soffice)) throw new Refusal(503, "converter_missing", `LibreOffice is not installed at ${config.soffice} (deploy/convert.sh installs it)`);
  const p = await proveSandbox();
  if (!p.proven) throw new Refusal(503, "sandbox_unproven", `nothing is converted: ${p.says}`);
  await slot();
  const job = join(config.jobs, `job-${Date.now()}-${randomBytes(6).toString("hex")}`);
  const t0 = performance.now();
  try {
    for (const d of ["in", "out", "profile/user", "tmp"]) mkdirSync(join(job, d), { recursive: true, mode: 0o700 });
    writeFileSync(join(job, "profile", "user", "registrymodifications.xcu"), XCU);
    const input = join(job, "in", `document.${kind}`);
    writeFileSync(input, bytes, { mode: 0o600 });
    const args = ["--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck", "--invisible", `-env:UserInstallation=file://${join(job, "profile")}`, "--convert-to", "pdf", "--outdir", join(job, "out"), input];
    const r = await run("/usr/bin/sandbox-exec", ["-p", profile(job), config.soffice, ...args], {
      cwd: job, timeoutMs: config.timeoutMs,
      env: { PATH: "/usr/bin:/bin", HOME: job, TMPDIR: `${join(job, "tmp")}/`, LANG: "en_US.UTF-8", SAL_USE_VCLPLUGIN: "svp" },
    });
    const ms = Math.round(performance.now() - t0);
    if (r.timedOut) throw new Refusal(422, "conversion_timeout", `the file was not converted within ${config.timeoutMs / 1000} s and was stopped`);
    const out = join(job, "out", "document.pdf");
    const pdf = existsSync(out) ? readFileSync(out) : null;
    if (!pdf || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Refusal(422, "conversion_failed", `LibreOffice made no PDF of this file (exit ${r.code})`);
    return { kind, pdf, ms };
  } finally {
    rmSync(job, { recursive: true, force: true });
    free();
  }
}

// ---------------------------------------------------------------------------------------------- HTTP

const MAX_BODY = Math.ceil(((Number(env.MUX_CONVERT_MAX_MB || 25) * 1024 * 1024) * 4) / 3) + 1024 * 1024;
const send = (res, status, obj) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };

export function server() {
  return createServer(async (req, res) => {
    const path = (req.url || "").split("?")[0];
    try {
      if (req.method === "GET" && path === "/health") {
        const p = await proveSandbox();
        return send(res, p.proven && existsSync(config.soffice) ? 200 : 503, { ok: p.proven && existsSync(config.soffice), sandbox: p.says, soffice: existsSync(config.soffice) ? config.soffice : null, running, waiting: waiting.length });
      }
      if (req.method === "GET" && path === "/v1/models") return send(res, 200, { object: "list", data: [{ id: config.model, object: "model", kind: "document", loaded: true }] });
      if (req.method !== "POST" || path !== "/v1/convert") return send(res, 404, { error: { message: "not found", type: "not_found" } });
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) throw new Refusal(413, "file_too_large", `the request is over ${MAX_BODY} bytes`);
        chunks.push(c);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Refusal(400, "invalid_request", "the body must be JSON"); }
      if (typeof body?.file_b64 !== "string" || !body.file_b64) throw new Refusal(400, "invalid_request", "file_b64 (the file, base64) is required");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.file_b64)) throw new Refusal(400, "invalid_request", "file_b64 is not base64");
      const bytes = Buffer.from(body.file_b64, "base64");
      const done = await convert(bytes);
      const sha256 = createHash("sha256").update(done.pdf).digest("hex");
      // One line per job, nothing of the file: its kind, sizes and time
      console.log(`${new Date().toISOString()} converted ${done.kind} ${bytes.length} B → pdf ${done.pdf.length} B in ${done.ms} ms`);
      return send(res, 200, { object: "conversion", model: config.model, input: done.kind, format: "pdf", bytes: done.pdf.length, sha256, ms: done.ms, pdf_b64: done.pdf.toString("base64") });
    } catch (e) {
      if (e instanceof Refusal) {
        console.log(`${new Date().toISOString()} refused ${e.status} ${e.type}`);
        return send(res, e.status, { error: { message: e.message, type: e.type } });
      }
      console.error(`${new Date().toISOString()} error ${e?.message}`);
      return send(res, 500, { error: { message: "the converter failed", type: "server_error" } });
    }
  });
}

/** Leftovers of a run that was killed (the folder is always deleted when a job ends; a crash cannot). */
function sweep() {
  if (!existsSync(config.jobs)) return;
  for (const name of readdirSync(config.jobs)) {
    const p = join(config.jobs, name);
    try { if (Date.now() - statSync(p).mtimeMs > 120_000) rmSync(p, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(config.jobs, { recursive: true, mode: 0o700 });
  sweep();
  setInterval(sweep, 300_000).unref();
  const p = await proveSandbox(true);
  console.log(`${new Date().toISOString()} sandbox: ${p.says}`);
  server().listen(config.port, "127.0.0.1", () => console.log(`${new Date().toISOString()} converter on 127.0.0.1:${config.port} (${config.soffice}, ${config.timeoutMs / 1000} s, ${config.maxBytes / 1048576} MB, ${config.parallel} at once)`));
}
