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
