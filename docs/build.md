# The build server

mux owns the GitHub Actions runners on the Mac Studio (owner, 2026-11-25: *"I want mux to take over all responsibility for
the build server and the code"*). Code: `server/src/build.ts` (watching, keeping up, figures), `deploy/build-runner.sh`
(adding and removing a runner), `web/src/pages/BuildServer.tsx` (Services → **Build server**, `/services?tab=build`).

## The runners (2026-11-25)

| runner | repository | folder | LaunchAgent |
|---|---|---|---|
| mac-studio-1 … mac-studio-4 | rummand/nexus | `~/.nexus/ci/runner-1..4` | `com.nexus.ci-runner-1..4` |
| mac-studio-blip-1, -2 | rummand/blip | `~/.blip/ci/runner-1..2` | `com.blip.ci-runner-1..2` |
| mac-studio-record, mac-studio-record-apps | rummand/record | `~/.record/ci/runner`, `runner-apps` | `com.record.ci-runner`, `-apps` |
| macstudio-bloom | rummand/bloom-for-business | `~/actions-runners/bloom-for-business` | `actions.runner.rummand-bloom-for-business.macstudio-bloom` |

mux finds them itself: every LaunchAgent in `~/Library/LaunchAgents` whose working folder holds a configured runner
(`.runner`), however it was installed (Nexus's, Blip's and Record's own plists, the runner's `svc.sh`, or
`deploy/build-runner.sh`). A configured folder under `~/actions-runners` without a LaunchAgent is listed as stopped.

## What mux does

- **Every minute** it asks GitHub through `gh` (logged in as the owner) for each repository's runners, its last 30 runs,
  and the jobs and steps of every run that changed. The first read after a start reads 100 runs a repository (~400
  calls, ~5 min, once; then ~10–40 calls a minute of the 5,000 an hour). Kept in `build_runs`, `build_jobs` (steps as
  JSON) and `build_samples` (per runner per minute: running, online, busy; 90 days).
- **Keeps them up:** a runner whose LaunchAgent is not running, or that GitHub has seen offline for 5 minutes, is
  restarted (`launchctl kickstart -k`), at most every 10 minutes, with an event. Restart by hand from its card.
- **The tab** shows the runners (state, the job and step running, last job, a minute-by-minute strip, busy share, Node),
  KPIs (pass rate, job time and waiting p50/p95, build hours, busy share, queued), a timeline of every job per runner,
  jobs finished per bucket, **builds against the Mac's CPU** (`system_samples`: builds share the Mac with the models),
  build time by repository, the steps where the minutes go and the steps that fail, flaky jobs (failed and passed on
  the same commit), each job's pass rate, p50/p95, wait and last 20 runs, recent failures with the step they stopped
  at, jobs waiting for a runner, and every recent run (also those on GitHub's machines).
- Its charts follow Nexus's admin charts (`apps/web/src/components/admin/Usage.tsx`, `atlas/BenchDashboard.tsx`):
  hand-drawn SVG in the theme's colours. Nexus had no GitHub Actions page; its build reports were Jenkins comments.

## Adding or removing a runner

```sh
./deploy/build-runner.sh rummand/<repo> [name] [labels]     # installs, registers, starts; mux sees it within a minute
./deploy/build-runner.sh --remove rummand/<repo> [name]
```

It checks the runner download against GitHub's SHA-256 digest, writes the runner's `.path` as a bare PATH (Bloom's own
script wrote `PATH=…`, so its runner fell back to Node 22), and puts Homebrew's `node@24` first on the runner's PATH
without relinking Homebrew's `node`, which mux runs on (Node 22, with a native SQLite module built for it).
