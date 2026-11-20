# mux

mux is the owner's model gateway: the Mac Studio runs the models, a Railway gateway routes tenants (Thread, Blip, others)
to them. Read `docs/handover.md` first (state of play), then `README.md` and `docs/decisions.md`.

## Standing rules from the owner

- **Licences: we are not commercial, we are research, and our location is the world.** Set by the owner on 2026-11-17:
  *"Fuck commercial use... we are not commercial"* and *"We are also research and our location is the world."* A model
  under a non-commercial, research-only or academic-only licence may be served, and a licence that excludes a territory
  (e.g. Hunyuan's, which excludes the EU) does not rule a model out. Don't drop a model for its licence. Still read every
  licence and write its terms beside the model (its `docs/*.md`), and keep attribution and share-alike terms (credit the
  source; changed weights we publish keep the licence). If a tenant starts charging money for output from a
  non-commercial model, raise it with the owner first.
- **Every model the owner's products use is hosted here** (owner, 2026-11-17: *"we need everything hosted on mux"*).
- **Every commit writes to `docs/handover.md`** (owner, 2026-11-17): one line at the top of its Log, newest first, with
  what the owner must run on the Mac. `tools/githooks/pre-commit` enforces it (`git config core.hooksPath tools/githooks`).
- The repo is public: never commit a token or key. Secrets live in `~/.mux/*.env` and Railway variables.
- `main` moves by fast-forward only, never forced.
- **Use Peekaboo for what only the Mac's screen can do** (owner, 2026-11-20: *"Remember you can use peekaboo"*). Peekaboo
  (`/opt/homebrew/bin/peekaboo`, openclaw/Peekaboo, MIT) is installed on the Mac Studio with Screen Recording and
  Accessibility granted (`./deploy/computer.sh`), so an agent working here can see and drive any app: a setting with no
  CLI or file (e.g. Orca's *Default agent*), a dialog, a native app. Look before acting — `peekaboo see --app <App>
  --json` gives a UI map with element ids; then `click --on <id> --snapshot <id>`, `menu`, `press`, `type`, and look again
  to check the change took. It needs the Mac's GUI session unlocked (a locked screen gives `CAPTURE_FAILED`; then ask
  the owner, or have them do it from Orca's UI). Prefer a CLI, API or file when one exists; act only on what the owner asked for; never
  enter passwords or approve payments; say what was clicked. The same tools back Ask mux's `computer_look`,
  `computer_list`, `computer_act` (`server/src/computer.ts`), where acting waits for the owner's approval.
