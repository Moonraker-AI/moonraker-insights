# Cron + Background Task Audit — 2026-04-23

Scope: `vercel.json` `crons` array, every handler under `api/cron/*`, shared
helpers `api/_lib/cron-runs.js`, `api/_lib/fetch-with-timeout.js`,
`api/_lib/monitor.js`, `api/_lib/auth.js`, and the atomic-claim SQL in
`migrations/2026-04-19-queue-claim-rpcs.sql` + `2026-04-19-audit-queue-claim-rpc.sql`.
Read-only. No Supabase queue-row spot-check performed (Supabase MCP not bound
in this audit session) — see Medium / Observability section for the
recommended human follow-up.

Severity summary: **C**: 1, **H**: 3, **M**: 6, **L**: 4, **N**: 3.

## Inventory

| Cron | Schedule (UTC) | Handler | Auth | Wrapped | Notes |
| --- | --- | --- | --- | --- | --- |
| enqueue-reports | `0 10 1 * *` | `api/cron/enqueue-reports.js` | `requireAdminOrInternal` | yes | Monthly, 1st @ 10:00. Dedup via report_queue UNIQUE + `resolution=ignore-duplicates`. |
| process-queue | `*/5 * * * *` | `api/cron/process-queue.js` | `requireAdminOrInternal` | yes | Atomic `rpc/claim_next_report_queue`, calls `POST /api/compile-report` (280s `AbortSignal.timeout`). |
| process-followups | `0 14 * * *` | `api/cron/process-followups.js` | `requireAdminOrInternal` | yes | Daily 14:00. Resend direct; processes ≤10 rows. |
| trigger-quarterly-audits | `0 11 * * *` | `api/cron/trigger-quarterly-audits.js` | `requireAdminOrInternal` | yes | Inserts `entity_audits` rows as `queued`; sends digest via Resend. |
| process-audit-queue | `*/30 * * * *` | `api/cron/process-audit-queue.js` | `requireAdminOrInternal` | yes | Dispatches one audit to `agent.moonraker.ai`. `rpc/claim_next_audit` (`queued→dispatching→agent_running`). 10s timeouts on `/health` and `/task/:id`. |
| check-surge-blocks | `0 * * * *` | `api/cron/check-surge-blocks.js` | `requireAdminOrInternal` | yes | Hourly. Probes agent `/ops/surge-status`. Handler budget watchdog (90s) + per-call timeouts. |
| process-scheduled-sends | `*/5 * * * *` | `api/cron/process-scheduled-sends.js` | `requireAdminOrInternal` | yes | Pulls due `newsletters`. 3-attempt retry with 5/15/60m backoff. Calls `/api/send-newsletter` on `clients.moonraker.ai`. |
| process-batch-pages | `*/5 * * * *` | `api/cron/process-batch-pages.js` | `requireAdminOrInternal` | yes | Atomic `rpc/claim_next_content_page`. Up to 5 batches/run, 1 page/batch. |
| cleanup-rate-limits | `30 6 * * *` | `api/cron/cleanup-rate-limits.js` | `requireAdminOrInternal` | yes | Prunes `rate_limits` (>24h) + `cron_runs` (>30d). |
| sync-attribution-sheets | `0 9 1 * *` | `api/cron/sync-attribution-sheets.js` | `requireAdminOrInternal` | yes | Monthly Sheets sync for all clients with `attribution_sync.enabled=true`. |
| backfill-gbp-daily | `0 9 * * *` | `api/cron/backfill-gbp-daily.js` | `requireAdminOrInternal` | yes | Daily. Thin wrapper around `api/backfill-gbp-warehouse.js` with `{all:true}`. |
| cron-heartbeat-check | `0 8 * * *` | `api/cron/cron-heartbeat-check.js` | `requireAdminOrInternal` | no (calls `start/finish` directly) | Reads latest `cron_runs.success` per known cron; `monitor.critical` when stale. |
| cleanup-stale-runs | `0 * * * *` | `api/cron/cleanup-stale-runs.js` | `requireAdminOrInternal` | yes | Hourly. Flips `cron_runs.status='running'` rows older than 1h to `error`. |
| agent-error-alerter | `15 8 * * *` | `api/cron/agent-error-alerter.js` | `requireAdminOrInternal` | yes | Groups `entity_audits.agent_error` by `last_agent_error_code` (last 72h). Sends Resend digest at ≥3/group. |

Orphan / drift check: all 14 `vercel.json` entries map to a real file, and all
14 files in `api/cron/` are scheduled. `functions` in `vercel.json` has 28
entries (22 headroom against the 50-entry hard limit).

---

## Findings

### CRITICAL

**[C1] `process-followups` has no retry. One Resend hiccup ⇒ terminal `status='failed'`.** — `api/cron/process-followups.js:58-65` and `:96-103`

The handler calls `sendFollowupEmail(...)`. On any `false` return (HTTP !ok,
JSON parse failure, Resend auth error, network timeout) it PATCHes the row to
`status='failed'` with `error_message: 'Send failed'`. There is no
`attempt_count`, no `retriable`, no `next_attempt_at`, no MAX_ATTEMPTS. The
cron does not retry on the next run — the status filter is
`status=eq.pending`, not `(pending OR retriable failed)`. A single 429 or
connection reset during a Resend burst permanently kills the followup send
for that prospect.

Blast radius: the two follow-up queues (`proposal_followups`,
`audit_followups`) drive the outbound warm-up sequence for
proposal + entity-audit prospects. Silent loss rate is proportional to Resend
availability — one bad minute during the 14:00 UTC window kills that day's
batch permanently. `send_followup_email` only logs via `monitor.logError`;
there is no `monitor.critical`, so the team never sees the deliberate
loss.

`process-scheduled-sends` already implements exactly the right pattern
(`send_attempt_count`, `send_retriable`, `send_next_attempt_at`, permanent vs
transient classification, `monitor.critical` at exhaustion). Mirror it onto
`proposal_followups` + `audit_followups`: add the three columns, classify
HTTP status, PATCH retriable + compute `next_attempt_at` via a 5/15/60-minute
backoff, and extend the initial SELECT to `(status='pending' OR
(status='failed' AND followup_retriable=true AND
followup_next_attempt_at<=now AND followup_attempt_count<3))`.

Fix is a self-contained migration + handler rewrite that mirrors
`migrations/2026-04-19-newsletter-send-retry.sql`.

---

### HIGH

**[H1] `process-audit-queue` Step 0.5 (agent_error requeue) can race against a concurrent Step 1 dispatch.** — `api/cron/process-audit-queue.js:278-294`

Step 0.5 selects `status=agent_error AND agent_error_retriable=true` and
flips each to `queued` via a per-row PATCH. Step 1 then atomically claims
`status=queued` via `rpc/claim_next_audit`. The race: if two cron invocations
overlap (`*/30` schedule + 120s maxDuration means ~8% overlap window on a
slow run), invocation B can enter Step 1 during invocation A's Step 0.5 and
claim a row A just flipped. That's safe in isolation, BUT B can ALSO claim
the row while A is still mid-loop (the loop PATCHes sequentially) — so B
dispatches to the agent with an audit whose `dispatch_attempts` counter A
thinks it owns. On the next failure the counter races and the
`MAX_DISPATCH_ATTEMPTS=5` cap is not reliably enforced.

Blast radius: in practice the cron is only `*/30`, and Step 1 exits early if
the agent is busy/unreachable, so the window is narrow. But the claim_next
RPC assumes it holds the only writer for the row through the HTTP dispatch
(~several-hundred-ms), which the Step 0.5 PATCH loop violates.

Fix sketch: fold Step 0.5 into a second SECURITY DEFINER RPC
(`requeue_retriable_agent_errors(limit int)`) using `UPDATE ... RETURNING`
with `FOR UPDATE SKIP LOCKED` on the inner SELECT. Same pattern as
`claim_next_audit`. Idempotent, atomic, and overlapping invocations see
disjoint row sets.

---

**[H2] `process-audit-queue` Step 0 requeues per-row PATCH on agent_running rows — no lock, no status guard.** — `api/cron/process-audit-queue.js:178-198`

The fast-path ("agent idle with 0 active_tasks, DB has agent_running rows →
container restart, requeue all") and unreachable-path ("agent unreachable,
requeue all") both iterate `runningAudits` and PATCH each to `status=queued`.
The PATCH has no `status=eq.agent_running` filter — if another cron
invocation mid-dispatch just flipped one of those rows to `agent_error` (via
a non-2xx agent response in Step 1), the requeue overwrites the terminal
status.

More concerning: the agent itself also writes row status via the callback
endpoint (`api/submit-entity-audit.js` or similar). If the agent completes a
task and PATCHes `status='complete'` in the same 30s window as this requeue
loop (`agent_idle_with_running_audits` can fire the moment the agent's
task-completion PATCH commits but before it flips `active_tasks`), the
complete row gets reverted to `queued` and re-dispatched — a duplicate
complete audit, potentially an email re-sent to the client.

Blast radius: low frequency (requires the agent's completion-PATCH and
/health to race on a 30-min cron), but the failure mode is silent duplicate
work + a duplicated client-facing email.

Fix sketch: add `&status=eq.agent_running` to the PATCH URL, and let
PostgREST discard the update cleanly if the row has already moved on. Same
guard belongs on the stale-dispatching requeue (`:160`).

---

**[H3] `process-queue` has no retry state on `report_queue.status='failed'`.** — `api/cron/process-queue.js:75-77` and `:102-106`

The atomic claim RPC (`rpc/claim_next_report_queue`) bumps `attempt` on every
claim, which is good. But the handler only sets `status='failed'` on compile
error and never reopens the row. The `scheduled_for <= now` predicate on
`claim_next_report_queue` scans only `status='pending'` rows, so a failed row
is permanently stuck. There is no `retriable` column, no
`next_scheduled_for`, no re-enqueue cron.

Blast radius: a monthly report that fails to compile (Anthropic 5xx,
timeout, missing GSC data) sits at `status='failed'` until a human notices
via `/admin/reports`. The team would discover this from a client complaint,
not telemetry.

Fix sketch: mirror `process-scheduled-sends` — add `report_retriable`,
`report_next_scheduled_at`, `report_attempt_count`. Extend
`claim_next_report_queue` to consider retriable rows whose
`report_next_scheduled_at <= now`. Classify compile errors: 4xx from
compile-report (permanent payload bug) terminal; 5xx/network (Anthropic
overload) transient with 15/60/240m backoff; `monitor.critical` at 3
attempts exhausted.

---

### MEDIUM

**[M1] `process-followups` response-status error classification.** — `api/cron/process-followups.js:106-112`

An outer-try catch returns `res.status(500)` (line 111). Under Vercel's cron
retry semantics, a non-2xx triggers retries. If the catch fires after half
the batch has been PATCHed to `status='sent'`, the retried run will skip
those (status filter is `eq.pending`) — good — but any `status='failed'`
rows from that batch become un-retriable via any mechanism (see C1). The 500
also dirties `cron_runs.error` even when the actual failure was a single row.

Fix sketch: return `res.status(200)` with `{ success: false, error,
results }` once per-row error accounting is in place (post-C1 fix). Keep the
outer 500 only for "no rows processed at all" scenarios where retry is safe.

---

**[M2] `process-scheduled-sends` outer-catch returns 500 → Vercel retries → duplicate sends possible.** — `api/cron/process-scheduled-sends.js:123-129`

The per-row try/catch is well-structured (M3 good-practice reference). But
the outermost try/catch around the whole loop returns `res.status(500)` on
any thrown exception, which causes Vercel to retry the entire cron. If the
first attempt succeeded for rows 1-3 and then crashed on row 4, the retry
fetches newsletter 4 again (good — it's still `status=scheduled` or
`status=failed`) but may also fetch 1-3 if the crash happened before the
PATCH that flipped their status to `sent`. Check: `/api/send-newsletter`
must be idempotent against the same `newsletter_id` being invoked twice
(out of scope for this audit, but flag for API slice).

Fix sketch: `res.status(200).json({ success: false, error, processed })` on
outer-catch, or explicit idempotency check in `/api/send-newsletter` before
touching Resend.

---

**[M3] `process-queue` / `process-batch-pages` telemetry snapshot blocks handler critical path.** — `api/cron/process-queue.js:26-41`, `api/cron/process-batch-pages.js:28-42`

The inline `try { ... } catch (snapErr) { /* telemetry failure never blocks
the cron */ }` pattern correctly swallows. But the `sb.query(... limit=1000
...)` is awaited BEFORE the atomic claim RPC runs. On a degraded Supabase
read path, this adds latency to every cron invocation before any work is
claimed, eating into the 300s maxDuration budget. In the worst case the
snapshot hangs the function past the claim and Vercel SIGKILLs before
`withTracking` can PATCH `cron_runs`.

Fix sketch: fire-and-forget the snapshot query via an async IIFE that
PATCHes `cron_runs` when it resolves. Don't `await` the SELECT on the claim
path. `withTracking.finish()` already records `queue_depth` separately via
its snapshot patch so a failed snapshot is just missing data, not a failed
cron.

---

**[M4] `process-followups` Resend call has no timeout.** — `api/cron/process-followups.js:119-130`

Naked `await fetch('https://api.resend.com/emails', ...)` with no
`AbortSignal.timeout` and no wrap through `fetch-with-timeout.js`. A stalled
Resend POST can sit for Node's default 5-minute socket timeout. 10 rows ×
5min = far past the cron's default 60s maxDuration. This is the same class
of hang that prompted the 90s watchdog in `check-surge-blocks`
(`:107`/`:279`).

Fix sketch: swap `fetch(...)` for `fetchT(...)` (existing
`api/_lib/fetch-with-timeout.js`) with a 15-second per-send budget. `check-surge-blocks:353`
and `agent-error-alerter:209` already use this pattern.

---

**[M5] `trigger-quarterly-audits` Resend call has no timeout.** — `api/cron/trigger-quarterly-audits.js:121-143`

Same pattern as M4 — naked `fetch('https://api.resend.com/emails', ...)`
with no abort signal, embedded in the single-email digest path. Lower blast
radius than M4 (one email per day, not 10), but cosmetically inconsistent
with the fetchT helper used elsewhere.

Fix sketch: swap to `fetchT(...)` with 15s timeout; log timeout via the
existing `monitor.logError` at line 147.

---

**[M6] `process-audit-queue` dispatch fetch to agent has no timeout.** — `api/cron/process-audit-queue.js:372-388`

The `fetch(AGENT_URL + '/tasks/surge-audit', ...)` does not set a
`signal`/`AbortSignal.timeout`, despite all other agent calls in the same
file (`/health:135`, `/task/:id:214`) using 10s abort timeouts. Dispatch POST
is the highest-stakes agent call — if the agent hangs after accepting TCP
but before responding, the cron holds the row in `dispatching` until Vercel
SIGKILLs at 120s (the route is not explicitly configured in
`vercel.json.functions`, so it uses the Pro 60s default — CHECK: this means
the cron dies at 60s, not 120s, which is much more aggressive than the
code assumes). Stale-dispatching requeue at `:151` recovers the row 2
minutes later, so the user-visible failure mode is a 2-minute delay per
hang, not a lost audit.

Fix sketch: add `signal: AbortSignal.timeout(30000)` (agent ACK latency is
typically sub-second; 30s is generous). Separate finding — the
`process-audit-queue` route is MISSING from `vercel.json.functions` entirely
while process-queue (300s) and process-batch-pages (120s) are explicitly
configured. Add `"api/cron/process-audit-queue.js": { "maxDuration": 60 }`
to make the budget explicit and surface it in code review.

---

### LOW

**[L1] `enqueue-reports` schedule `0 10 1 * *` is 10:00 UTC on the 1st — comment says "10am" without TZ qualifier.** — `api/cron/enqueue-reports.js:2`, `vercel.json`

10:00 UTC is 03:00 PT / 06:00 ET. Probably intentional (quiet window before
US morning), but the code comment on line 2 ("Called by Vercel Cron on 1st
of month") doesn't specify. Low priority — no functional bug, just a
documentation nit that causes repeat questions when someone new checks the
schedule.

Fix sketch: append "(10:00 UTC = 03:00 PT)" to the schedule comment and the
handler header comment.

---

**[L2] `cron-heartbeat-check` never fires `monitor.critical` on `never_run` crons.** — `api/cron/cron-heartbeat-check.js:59-77`

By design (documented on :63-69). Deliberate soft-fail to avoid spamming on
monthly crons that have not yet fired. But this has a blind spot: a
net-new cron that is forgotten in the `EXPECTED` map goes silently
unmonitored. Mitigation: run a once-weekly assertion that every cron in
`vercel.json.crons` has an entry in `EXPECTED`.

Fix sketch: extend `cleanup-stale-runs` (hourly, lightweight) to read the
Vercel project config's crons endpoint, diff against `EXPECTED`, and fire
`monitor.warn` on drift. Or simpler: add a unit-test-style self-check at the
top of `cron-heartbeat-check` that reads its own file list under `api/cron/`
and compares against `Object.keys(EXPECTED)`.

---

**[L3] `cleanup-stale-runs` auto-expires running rows at 1h, but heartbeat tolerances allow 3h stale.** — `api/cron/cleanup-stale-runs.js:19` vs `cron-heartbeat-check.js:26`

`cleanup-stale-runs` flips any `status='running'` row older than 1h to
`error`. `cron-heartbeat-check` tolerances for hourly crons are
`intervalSec: 3600, toleranceSec: 3 * 3600` = 4h total. A 1-3h gap for an
hourly cron (e.g. `check-surge-blocks`, `cleanup-stale-runs` itself) is not
alerted, but the stuck row IS auto-flipped to error. Effect: the heartbeat
still sees a successful previous run and doesn't alert, because the flipped
row is `status='error'` not `status='success'`, and the heartbeat query
filters on `status=eq.success`. Consistent — but the user must know both
numbers to reason about coverage.

Fix sketch: document the interaction in a comment at the top of
`cron-heartbeat-check.js` next to the `EXPECTED` map.

---

**[L4] `cleanup-rate-limits` comment says "0 6" but vercel.json schedules `30 6`.** — `api/cron/cleanup-rate-limits.js:8`, `vercel.json` crons index 8

Comment on line 8 documents `"0 6 * * *"`; actual schedule is `"30 6 * * *"`
(daily 06:30 UTC). Doc-only drift, no functional impact.

Fix sketch: update the comment to `"30 6 * * *"`.

---

### NIT

**[N1] `process-scheduled-sends` merges queries into 5 items, retry query uses `limit=5` so `scheduled + retriable` can both be full and the slice silently drops retriable rows.** — `api/cron/process-scheduled-sends.js:47-58`

On a day with ≥5 fresh `status='scheduled'` newsletters at the 5m tick, the
retry query returns up to 5 more; the `.slice(0, 5)` drops all of them. A
retriable row waiting in backoff will wait another 5 minutes. Minor — the
next cron tick picks it up. But under sustained failure + high publish
cadence, retriable rows can starve indefinitely.

Fix sketch: change to `.slice(0, MAX_PER_RUN)` with `MAX_PER_RUN=10` (or
interleave the two lists).

---

**[N2] `backfill-gbp-daily` rewrites `req.method` and `req.body` on the Vercel req object.** — `api/cron/backfill-gbp-daily.js:33-34`

Functional and documented, but muts `req` in place. If the upstream handler
ever logs `req.method` in an error path, it will report "POST" for what
was really a Vercel GET cron invocation, making debugging harder.

Fix sketch: pass a shallow-cloned `{ ...req, method: 'POST', body: {all:true} }`
instead.

---

**[N3] `trigger-quarterly-audits` cron comment says "daily at 7:00 AM ET (11:00 UTC)" but `0 11 * * *` is only ET during Standard Time.** — `api/cron/trigger-quarterly-audits.js:10`, `vercel.json`

During EDT (March-November), 11:00 UTC is 7:00 AM ET if you mean Eastern
Time generically. Actually it's 7:00 AM EDT. The schedule drifts 1h between
DST regimes because Vercel crons run in UTC. Cosmetic — the cron fires at
the same wall-clock time all year if you think in UTC, just the ET label
drifts.

Fix sketch: either (a) drop the ET reference and keep only UTC; or (b)
accept the drift and document it.

---

## Concurrency / idempotency patterns to fix systemically

1. **Two-phase requeue loops (H1, H2).** `process-audit-queue` Step 0 +
   Step 0.5 do sequential PATCH loops while a concurrent invocation can be
   running Step 1's atomic claim. Pattern: fold each requeue loop into its
   own SECURITY DEFINER RPC with `FOR UPDATE SKIP LOCKED` + status-guard
   WHERE clause. Same template as `claim_next_audit`.

2. **`send_retriable` retry state (C1, H3).** Two queues have it
   (`newsletters`, `entity_audits.agent_error_retriable`) and two do not
   (`proposal_followups`, `audit_followups`, `report_queue`). Normalize so
   every queue carries `<task>_attempt_count`, `<task>_retriable`,
   `<task>_next_attempt_at`, `last_<task>_error` and crons read
   `(status=pending OR (status=failed AND retriable=true AND
   next_attempt<=now AND attempt<MAX))`.

3. **`fetchT` vs naked `fetch` (M4, M5, M6).** Three production cron code
   paths still use naked `fetch()` with no timeout. Normalize to
   `api/_lib/fetch-with-timeout.js` — the module is already present, already
   used by `check-surge-blocks` and `agent-error-alerter`.

## Observability gaps

1. **Supabase queue-row spot-check not performed.** Recommend a manual
   follow-up:
   - `SELECT status, count(*), min(created_at) FROM report_queue GROUP BY status;`
   - `SELECT status, count(*), min(created_at) FROM entity_audits GROUP BY status;`
   - `SELECT status, count(*), min(scheduled_at) FROM newsletters GROUP BY status;`
   - `SELECT status, count(*), min(scheduled_for) FROM proposal_followups GROUP BY status;`
   - `SELECT status, count(*), min(scheduled_for) FROM audit_followups GROUP BY status;`
   Any `status='failed'` row on the followup queues or report_queue older
   than a week is (per C1/H3) permanently stuck and worth surfacing before
   the fix lands.
2. **Heartbeat EXPECTED-map drift (L2)** — a new cron added to
   `vercel.json` and `api/cron/` without a matching `EXPECTED` entry is
   unmonitored.
3. **Vercel cron delivery vs cron_runs coverage.** If Vercel silently fails
   to invoke a cron (deploy protection blocking the invocation, cron
   disabled in the UI), the heartbeat alerts correctly. But if Vercel calls
   the route and our auth rejects it (CRON_SECRET mismatch after rotation),
   `withTracking.start()` does record a `cron_runs` row in `status='running'`
   → `status='error'` with "HTTP 401". This is fine — noting here so
   remediation doesn't break it.

## Quick wins (safe, cheap, ordered)

1. `L4`: doc-only — fix `cleanup-rate-limits.js:8` comment.
2. `M4` + `M5`: swap `fetch` → `fetchT` in two crons. 2-line diff each.
3. `M6`: add `signal: AbortSignal.timeout(30000)` to
   `process-audit-queue.js:372` agent dispatch fetch. 1-line diff.
4. `H2`: add `&status=eq.agent_running` to `process-audit-queue.js:183` +
   `:193` + `&status=eq.dispatching` to `:160` PATCH URLs. 3-line diff, pure
   additive filter.
5. `M6` part 2: add explicit `"api/cron/process-audit-queue.js": {
   "maxDuration": 60 }` (or `120`) to `vercel.json.functions`. 1-line
   addition; within the 50-entry budget.

## Needs architectural decision

**Decision A — retry-state rollout for followups + report_queue (blocks C1 and H3).**

- **A (recommended):** Mirror the `newsletters.send_*` pattern onto
  `proposal_followups`, `audit_followups`, `report_queue`. One migration per
  table (`<task>_attempt_count`, `<task>_retriable`, `<task>_next_attempt_at`,
  `last_<task>_error`). Extend each cron's claim query. Matches existing
  conventions, uniform retry model across all queues. Cost: 3 migrations +
  3 handler rewrites + partial index per table. Maybe a day's work.

- **B:** Use a single `queue_retry_state` table keyed by `(queue_name,
  row_id)`. DRYs the columns but adds a join on every claim. Less elegant,
  harder to introspect.

- **C:** Reuse the existing `cron_runs.detail` jsonb to record per-row
  retry state. Awful from a query perspective; do not recommend.

Recommendation: **A**. The team already understands the pattern from
`newsletters`.

**Decision B — fold Step 0 + Step 0.5 into RPCs (blocks H1, H2 beyond the quick-win filter).**

- **A (recommended):** Add `requeue_stale_running_audits(idle_zero bool,
  cutoff_ts timestamptz, limit int)` and
  `requeue_retriable_agent_errors(backoff_cutoff timestamptz, limit int)`
  RPCs. `SELECT … FOR UPDATE SKIP LOCKED` on inner query ⇒ concurrent-safe.
  Collapses three JS loops into two RPC calls.

- **B:** Leave the JS loops but add the status-guard WHERE clauses
  (quick-win #4). Gets rid of the worst failure mode without the migration
  surface area. Still racy on `dispatch_attempts` counter increments.

- **C:** Advisory lock around the entire cron handler
  (`pg_try_advisory_lock`). Simple, but a crashed cron invocation holds the
  lock until the session times out.

Recommendation: **A** in the follow-up batch, but ship **B** as an
immediate quick-win in the same commit as L4/M4/M5. The two are
complementary.

**Decision C — add DLQ-style admin view for exhausted retriable queues?**

- **A (recommended for this team size):** After the retry columns land,
  extend `/admin/system` to show a "Retry exhausted" table joining rows
  across all queues where `retriable=false AND attempt_count>=MAX`. No new
  tables.

- **B:** Dedicated `queue_deadletter` table. Cleaner separation, more
  schema. Overkill at current volume.

Recommendation: **A**. One admin-page change, no schema migration.
