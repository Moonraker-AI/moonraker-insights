# 2FA credential storage in `workspace_credentials`

**Date:** 2026-04-22
**Author:** Chris Morin + Claude
**Scope:** `workspace_credentials.authenticator_secret_key`, `.authenticator_backup_codes`, `.qr_code_image`
**Supersedes:** security audit L5 removal (commit `b4723db4cc`, 2026-04-18)

## TL;DR

We removed the 2FA storage columns and UI on 2026-04-18 because nobody was populating them. We restored them on 2026-04-22 because the team is now actively storing client-Gmail credentials in Client HQ and needs the full recovery set co-located. The restored design is not a straight revert — it masks all three fields by default in the DOM (click-to-reveal, same pattern as `gmail_password`) and encrypts each `authenticator_backup_codes[]` element individually rather than storing the array plaintext.

## Why the original removal happened

Commit `b4723db4cc` ("Remove 2FA authenticator UI + encrypted columns (security audit L5)") dropped three columns and all associated UI on the grounds that:

1. **4/4** `workspace_credentials` rows had `authenticator_*` fields null since table creation. The feature was dead weight.
2. Storing TOTP seeds in an application DB — even encrypted at rest — is a weak pattern when a better one exists (Supabase's native `auth.mfa.enroll`).
3. The UI rendered the QR image and revealed backup codes into the DOM on view, creating a "standing plaintext" window every time an admin opened the tab.

The removal kept the `two_fa_enabled` boolean as a metadata marker.

## Why we reversed it

The "nobody populates these" premise no longer holds. By 2026-04-22 the team was actively storing client-Gmail workspace credentials (Gmail address, password, backup email, backup phone, app password) for onboarded clients in Client HQ, and hit the gap when they needed to record the recovery set for the Gmail account they'd just created. The alternatives were:

- **1Password / Dashlane** — we asked, the team isn't using these for client credentials.
- **Supabase native MFA** — not applicable. That API is for *our* users' MFA against *our* app, not for storing TOTP seeds for third-party (Google) accounts we operate on behalf of clients.
- **No storage, team workflow to remember** — unacceptable; recovery codes lost to a team rotation would lock the client out.

Client HQ is where these creds live. Adding QR + backup codes + TOTP seed to the same row is the honest answer.

## What changed in the restoration vs. the pre-removal design

| Concern | Pre-removal design | Restored design (this doc) |
|---|---|---|
| Encryption at rest (secret, QR image) | ✅ encrypted | ✅ encrypted (unchanged) |
| Encryption at rest (backup codes array) | ❌ plaintext — `decryptFields` ran `decrypt()` on elements but they were stored plaintext, the passthrough branch returned them unchanged | ✅ each element encrypted individually via generalized `encryptFields` (see `api/_lib/crypto.js`) |
| QR image in DOM | Rendered thumbnail unconditionally on every view | Placeholder tile by default (`•••• QR hidden`) → click-to-reveal → thumbnail → optional fullsize overlay |
| Backup codes in DOM | Masked with count (`•••• (N codes)`) by default — same as now | Unchanged (this part of the original design was already right) |
| TOTP seed in DOM | Column existed but had no UI — seed was never rendered | New masked row, same pattern as `gmail_password`: `•••• ` (length-bounded) → click-to-reveal |
| Access gate | Admin JWT + `admin_profiles` check | Unchanged |
| `revealWsField` reset | Cleared on save | Unchanged |
| UNIQUE(contact_id) | ❌ absent — duplicate inserts possible | ✅ enforced (separate migration the same day) |

The masking-by-default is the material delta. The audit's "standing plaintext in the DOM" concern was legitimate; the restored UI only materializes the sensitive values when an admin explicitly clicks to reveal, and a save-cycle clears the reveal state. An admin accidentally screen-sharing the Rising Tide tab no longer exposes the QR image or TOTP seed by default.

## What we did NOT change

- The TOTP seed is still stored in an application DB rather than an HSM or a dedicated secrets manager. We accept this tradeoff because the operational alternatives (team memory, 1Password we don't use, a separate secrets service we'd have to build and secure) are worse.
- The encryption key lives in Vercel env (`CREDENTIALS_ENCRYPTION_KEY`). Key rotation infrastructure exists in `api/_lib/crypto.js` (v1/v2 prefix routing) but the key hasn't been rotated since introduction. A rotation drill is worth doing independently of this decision.

## If this premise breaks again

Two failure modes to watch for:

1. **Rows stop getting populated.** If we find ourselves six months out with a bunch of clients whose 2FA fields are still null, the removal rationale comes back into play. Re-check adoption rate quarterly.
2. **An incident involving one of these fields.** If a TOTP seed leaks from the DB (backup exposure, SQL injection, compromised admin account), the right response isn't necessarily to re-remove — it's to move to a secrets manager. Flag it to Chris and revisit this doc.

## Code references

- Columns: `ALTER TABLE workspace_credentials ADD COLUMN ...` — migration `workspace_credentials_restore_2fa_columns` (2026-04-22)
- Encryption: `api/_lib/crypto.js` — `SENSITIVE_FIELDS` array + generalized `encryptFields` / `decryptFields` handling text[] arrays element-wise
- UI: `admin/clients/index.html` — `renderWorkspace` (view mode), `renderWorkspaceEdit` (edit mode), `maskedFields` array, `revealWsField`, `showQrFullsize`, `copyBackupCode`, `parseBackupCodes`, `initQrPasteZone`, `handleQrImage`, `removeQrImage`
- Prior removal: commit `b4723db4cc`
- Prior commit where the feature lived: `15c6c106503fbce31a4fd9f2f7fc590a4853c9f7` (its parent)
