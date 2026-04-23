# Agent VPS Audit — 2026-04-23

Scope: VPS host + Moonraker Agent container + host admin service + Caddy + SSH + fail2ban. Read-only; no remediation. Supabase audit-pipeline counts not pulled (no `SUPABASE_SERVICE_ROLE_KEY` in auditor shell); evidence below is host + container + logs only.

## Host State

| Item | Value |
|---|---|
| Host | `moonraker-agent-ash` / Hetzner vServer / Ubuntu 24.04.4 LTS |
| Kernel | `6.8.0-110-generic` |
| Uptime | 4d 5h (last boot ~2026-04-19 07:32) |
| Load | 0.06 / 0.02 / 0.00 |
| Memory | 7.6 GiB total, 774 MiB used, 6.8 GiB available |
| Swap | 2.0 GiB, ~768 KiB used |
| Disk `/` | 150 GB, 35 GB used (25%) |
| Docker disk | Images 24.92 GB, **Build Cache 28.88 GB reclaimable** |
| Reboot required | no |
| Upgradable packages | 5 (`docker-ce`, `docker-ce-cli`, `docker-ce-rootless-extras`, `docker-model-plugin`, `snapd`) |
| Unattended-upgrades | active, `Automatic-Reboot=false` (commented / default) |
| Container count | 1 (`moonraker-agent` up 8h, healthy, restart_count=0) |
| Agent image | `moonraker-agent-agent:latest`, built 2026-04-23 04:25 |
| Agent version | `AGENT_VERSION = "0.7.1"` (`/health` confirms `version=0.7.1`, active_tasks=0, total_tasks=5) |
| VPS repo HEAD | `b5a45fa server: wire sitemap_scout (Tier 1), bump AGENT_VERSION 0.7.0 -> 0.7.1` (clean) |
| Caddy TLS | `CN=agent.moonraker.ai`, expires 2026-07-06 (73 days) |
| SSH | `PermitRootLogin prohibit-password`, `PasswordAuthentication no`, 1 key (`chris@moonraker.ai`) |
| Firewall | UFW active, 22/80/443 only; 8000 + 8001 bind 127.0.0.1 |
| fail2ban | 2 jails — `sshd` (1 currently banned, 2442 total), `caddy-admin-401` (0 currently banned, 1 total) |

## Surge Audit Pipeline Status

Agent service is **up and healthy**. `/healthz` returns 200; `/health` returns `{"status":"ok","version":"0.7.1","active_tasks":0,"total_tasks":5}`. Caddy access log shows regular `/health` polls from Vercel (`52.23.158.100`, `54.173.160.66`) returning 200 — i.e. CHQ → agent channel is alive.

**No live Surge evidence this session.** Container has only run since 2026-04-23 04:25 (rebuilt to land `b5a45fa`, 8h uptime). Grep for `surge|callback|rejected|maintenance|credits|terminal_fail` over 14d of `docker logs` returned **zero hits**. Two interpretations, both worth checking with the API/cron agents who own the other side of the channel:

1. No Surge-audit tasks have been dispatched in the last 8h since the new container started (plausible — queue cron is half-hourly and may have been quiet).
2. Pre-rebuild log history is gone (json-file rotates at 10 MB × 3; the current active file is only 149 KB, so most of the 14d window lives in prior rotations that may have been pruned). The `--since 14d` filter only sees what's on disk now.

OOM history is still on the box: **`Apr 12 12:01:01 moonraker-agent kernel: Out of memory: Killed process 97612 (chrome) total-vm:50694812kB`** — one confirmed OOM kill of chromium 11 days ago. No OOM events in the last 4 days.

Answer to "is Surge broken": **unknown from VPS alone** — agent is healthy, no active errors, but the window of available logs is too short to confirm recent successful runs. Cross-check against Supabase `entity_audits` (DB agent's slice) to resolve.

## Findings

### CRITICAL

None. SSH posture is clean, no world-writable secrets, no exposed admin ports, TLS current.

### HIGH

- **[H1] Token rotation age unknown but staleness likely** — `/opt/moonraker-agent/.env` mtime is **2026-04-19 06:48** (4 days ago), `/opt/moonraker-admin/.env` mtime is **2026-04-19 06:24**. md5sum `1c45e042cbc4d9e31a29dcdac4b32f5a` for agent env. Both files are tiny and last touched during what looks like initial bootstrap. Neither token age is tracked; there is no automated rotation. `AGENT_API_KEY` is the same symmetric secret gating CHQ → agent and agent → CHQ, and also gates `/admin/exec` for the admin service (two separate tokens, both named `AGENT_API_KEY`). Any compromise vector affecting Vercel env exposes the agent task token. Flag for remediation-phase rotation — do not rotate now.
- **[H2] `/admin/exec` is arbitrary shell, no command whitelist, no rate limit** — `admin_service.py` `exec_command` takes `req.command: str`, pipes straight to `asyncio.create_subprocess_shell`, runs as `mradmin` (docker group, non-root). Auth is constant-time Bearer compare, no per-IP throttle inside the service, no allowlist, no denylist. The only mitigation is Caddy-level: fail2ban `caddy-admin-401` jail (5×401/10min → 24h). Valid-token abuse is uncapped and indistinguishable from legitimate use. Blast radius = arbitrary shell as `mradmin` + docker group (which equals root via `docker run -v /:/host` escape). Fix sketch: add a per-jail rate limit on `/admin/*` regardless of status code, or move exec to a nonces-per-command pattern; longer-term, replace with a narrow set of named RPC endpoints. Known tradeoff called out in the playbook; flag severity accordingly.
- **[H3] Caddy `caddy-admin-401` jail filter matches on `"status":401` in one-line JSON, but Caddy sometimes emits wrapped log lines** — current filter: `failregex = ^.*"remote_ip":"<HOST>".*"uri":"/admin/[^"]*".*"status":401.*$`. Caddy's JSON log writes one event per line today (confirmed by tail), so this works. The jail has only recorded **1 total failure ever** (zero bans), while `sshd` shows 14,027 total failures / 2,442 bans over the same horizon. Either nobody is poking `/admin/*` (plausible, it's not linkable), or the filter is missing hits because auth failures return 500 (no `AGENT_API_KEY` configured branch) or 422 (pydantic rejection) instead of 401. The playbook specifically calls this out as FS-9. Fix sketch: extend the regex to match `"status":(401|403|422)`, OR add a separate `caddy-admin-422` jail with a lower threshold, OR — better — fix the root cause in `admin_service.py` by switching auth to a `Depends(verify_key)` path-op dependency so validation errors still emit 401.
- **[H4] Admin service has no audit log of the `command` body to an append-only / off-host sink** — `/var/log/moonraker-admin/app.log` is local, rotating (10 MB × 3), owned by `mradmin`. Anyone with shell as `mradmin` (i.e. anyone who successfully authed to `/admin/exec` one time) can rewrite the log. No off-host shipping, no Supabase mirror, no immutability. If a key leaks, you cannot prove post-facto what was run. Fix sketch: tee every EXEC line to Supabase via service-role insert, or journald + remote syslog.

### MEDIUM

- **[M1] Docker build cache hoarding 28.88 GB** — `docker system df` shows 28.88 GB reclaimable in Build Cache vs 150 GB disk / 35 GB used. Not a pressure item today but it's 19% of total disk sitting idle. Deploy workflow uses `--no-cache` on Dockerfile changes which is presumably why it accumulates. Fix sketch: nightly `docker builder prune -f --filter until=168h` via cron.
- **[M2] `docker-ce` pinned behind one patch release** — Upgradable 5:29.4.0 → 5:29.4.1. `unattended-upgrades` is active but Docker's origin (`docker.com`) is not in `Unattended-Upgrade::Allowed-Origins` by default. Same applies to `snapd`. None of these are CVE-class that I can see, but they represent permanent opt-out of patching on the host's container runtime. Fix sketch: either add `docker.com/noble` to allowed origins, or schedule a monthly manual `apt upgrade` during a low-risk window.
- **[M3] `fail2ban-client status sshd` shows 14,027 total failures** — SSH is under constant brute-force scan (Apr 18 alone has `Invalid user joomla from 178.156.145.41`, typical script kiddie). Key-only auth makes this low-impact, but firehose fills logs and wastes CPU on reject cycles. Fix sketch: move `Port 22` → non-standard port (drops 90%+ of automated probes) OR tighten `MaxAuthTries` and `LoginGraceTime`.
- **[M4] Host admin service runs without a `ProtectSystem` / `PrivateTmp` systemd drop-in** — unit has `User=mradmin Group=mradmin WorkingDirectory=/opt/moonraker-admin` but no sandboxing directives. `mradmin` in docker group can still escalate via `docker run`. Fix sketch: add `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=/var/log/moonraker-admin /opt/moonraker-admin`. Docker group membership has to stay (that's the point of the service) so full lockdown isn't possible, but these cut most ancillary surfaces.
- **[M5] No off-host log shipping** — all observability is on the VPS (Caddy access log, admin app.log, docker json-file). A drive corruption or a restore from Hetzner snapshot reverts the log state. Also: no alerting on `/health` → non-200. Fix sketch: ship admin log to Supabase or Better Stack; add an external blackbox monitor (Vercel cron? Better Uptime?) on `https://agent.moonraker.ai/healthz`.

### LOW

- **[L1] `docker-compose.yml` is world-readable (`-rw-r--r-- root:root`)** while `.env` is `-rw-r----- root:mradmin`. Not a secret, but the compose file does reference the mounted host path `/data/profiles` and volume names; clean up to `640 root:mradmin` for consistency.
- **[L2] `.env.example` is world-readable in two places** (`/opt/moonraker-agent/.env.example`, `/opt/moonraker-agent/host_admin/.env.example`). These are intentional templates and contain no real secrets — informational flag only.
- **[L3] Container has no `security_opt: [no-new-privileges:true]` and no capability drops** — `Privileged=false` (good), but `CapAdd=null`, `CapDrop=null`, `SecurityOpt=null`. A CVE in the agent or in Chromium that lets the attacker escalate inside the container has the default Docker capset available. Low because the container already runs as uid 1000 and the attack chain is long, but easy wins are `cap_drop: [ALL]` + `cap_add: [NET_BIND_SERVICE]` (or none — it listens on 8000, no privileged ports) + `security_opt: [no-new-privileges:true]`.
- **[L4] Caddy access log is `0600 caddy:caddy`** in `0755 caddy:caddy` dir — good on the file, but the parent `/var/log/caddy/` is `0755` so the filename itself is discoverable. Noise.
- **[L5] `Automatic-Reboot=false`** in unattended-upgrades — correct decision given live Surge audits, but it means kernel fixes sit unapplied until a manual reboot. Pair with a monthly planned reboot window or a `/health?active_tasks=0` auto-reboot gate.
- **[L6] `memswap_limit: 5g` allows 1 GB swap into swap** — on a VPS with a 2 GB swapfile on the same disk. Under Chrome RSS spikes this turns into disk thrash rather than OOM (which is arguably worse — slow failures instead of fast). Either raise `mem_limit` or drop `memswap_limit` to match `mem_limit`.

### NIT

- **[N1] Dockerfile comment says "Chromium with --no-sandbox runs fine unprivileged"** — a correct statement that will age poorly if Chromium's sandbox requirements change. Worth a version pin comment.
- **[N2] `AGENT_VERSION = "0.7.1"`** matches HEAD commit; good. Remind to bump on every user-visible change.
- **[N3] Caddy `log level INFO`** emits the full `Authorization: ["REDACTED"]` header — redaction is working. No action.
- **[N4] `/tmp/agent-debug/` inside container is world-writable (1777)** per Dockerfile comment. Fine for debug artifacts; worth confirming it's not bind-mounted to host (it isn't — volumes list has no mount for it).

## Top 3 (for reply)

1. **[H2]** `/admin/exec` is arbitrary shell behind a single symmetric bearer — rate-limit, whitelist, or narrow to named RPCs before the token is rotated.
2. **[H3]** fail2ban `caddy-admin-401` filter only catches status 401; 422 (malformed body) and 500 (no `AGENT_API_KEY`) slip through — widen regex or fix auth order in `admin_service.py`.
3. **[H1]** Agent + admin tokens both untouched since 2026-04-19 bootstrap. Plan coordinated rotation for next maintenance window (do not rotate ad-hoc — Vercel + VPS + container-recreate triple).

## Evidence references

- `docker inspect moonraker-agent` — `User=appuser uid=1000`, `Memory=4294967296`, `Privileged=false`, `RestartCount=0`, `StartedAt=2026-04-23T04:25:51Z`.
- `/opt/moonraker-agent/.env` — `640 root:mradmin`, mtime 2026-04-19 06:48, md5 `1c45e042cbc4d9e31a29dcdac4b32f5a`. Keys present: `ANTHROPIC_API_KEY`, `SURGE_URL`, `SURGE_EMAIL`, `SURGE_PASSWORD`, `CLIENT_HQ_URL`, `AGENT_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SQ_EMAIL`, `SQ_PASSWORD`.
- `/opt/moonraker-admin/.env` — `600 mradmin:mradmin`, mtime 2026-04-19 06:24.
- TLS — `notAfter=Jul 6 07:18:07 2026 GMT`, 73 days remaining.
- OOM — `Apr 12 12:01:01 Out of memory: Killed process 97612 (chrome)`; no further OOM events.
- fail2ban — `sshd` 14,027 failed / 2,442 banned / 1 currently banned (`213.209.159.159`); `caddy-admin-401` 1 failed / 0 banned.
- `docker system df` — Build Cache 28.88 GB reclaimable.
- Repo state — HEAD `b5a45fa` matches live code; AGENT_VERSION string in `server.py` matches `/health` response.
