import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test process gets a home and a database of its own, before any of mux is loaded: a test that imports the
// router (which opens the database) must never touch the real ~/.mux/mux.db.
const dir = mkdtempSync(join(tmpdir(), "mux-test-"));
process.env.MUX_HOME ??= dir;
process.env.MUX_DB ??= join(dir, "mux.db");
process.env.MUX_PORT ??= "1";
// Never fetch a model from a test: the autopilot would download gigabytes into the temporary home.
process.env.MUX_NO_DOWNLOADS = "1";
// Never touch the real screen from a test: on the Mac Studio Peekaboo is installed, and the computer tests would look,
// click and start Peekaboo agent runs for real (2026-11-17: two tests failed there because they did).
process.env.MUX_NO_COMPUTER = "1";
// Never ask GitHub or restart the Mac's CI runners from a test.
process.env.MUX_NO_BUILD = "1";
