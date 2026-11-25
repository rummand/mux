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

## The build keeper (the agent)

Owner, 2026-11-25: *"it's your task to secure that the build server is running all time … an agent running on that
and fully integrated to brain … keep it alive 24-7 and secure it has the right resources … taking over all issues and
commands for the build service, failed builds … communicate back and forth with the repos."* `server/src/buildKeeper.ts`,
on the Agents page and at the top of Services → Build server. After every look at GitHub (each minute):

- **Rules, no model:** a runner whose LaunchAgent lacks KeepAlive or background priority is hardened when idle
  (`POST /build/runners/{name}/harden`: KeepAlive, ProcessType Background, Nice 10, LowPriorityIO, as Nexus's runners
  have; at most once an hour per runner); with under 20 GB of disk free, the 3 largest idle runners' work folders are
  emptied (`/clean`; the tool cache stays). build.ts restarts a stopped runner.
- **Cases** (`build_cases`), one per problem, with new evidence added: a job failing on this Mac (per repository and
  job; closed when it passes again), a runner still down 15 minutes on, a job waiting over 20 minutes, the disk under
  30 GB, and each message in a repository's **"Build server (mux)"** issue (read every 3 minutes).
- **The agent** works one case at a time (≤ 20 an hour; a failing job at most every 30 minutes): the assistant
  headless (route `auto`, today qwen3.6), with mux's tools and brain, as the healer's doctor. It reads the log
  (`GET /build/jobs/{id}/log?grep=`), decides whose problem it is, fixes the build server's (restart, clean, harden,
  **one** re-run of a job that failed for the server's reasons), tells the repository what is the repository's
  (`POST /build/say`: on the job's pull request or commit, editing its own comment when there is news, at most 3
  times an hour per case), answers messages in the thread, and writes runbooks into the brain. Every other change is a
  proposal the owner approves on the case. Its reports go to the brain keeper with the doctor's.
- Talking with a repository: write in its "Build server (mux)" issue (mux opens it the first time it has something to
  say: bloom-for-business #152); mux answers there within minutes. Its own comments end with "— mux build server
  (automated …)", which is how it tells them from yours (they are posted with the owner's `gh` login).

## Record first

Record's own services (speech-da on :8798, the speakers service, record-training) share this Mac's GPU and cores with
the builds. Every 15 s the build keeper asks Record what record-training asks (speech-da `/live/status`, Record
`/api/training/busy`, with `SPEECH_DA_KEY` from `~/.record/etc`); while a live meeting streams or parts wait to be
written down, every CI step running here is paused (SIGSTOP to the step's script and all under it; the runner process
is left running so GitHub keeps seeing it), and resumed when Record is clear, after 20 minutes at most (then not paused
again for 10), when mux stops, and when mux starts. Why: on 2026-11-25 Record's CI diarization check made a 43-minute
recording's Røst and speakers calls time out.
