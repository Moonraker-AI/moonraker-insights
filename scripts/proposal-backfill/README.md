# Proposal backfill for Edward Chan + Ray Miller

Both contacts existed in `prospect` status with on-disk baked proposal HTML
but no `proposals` DB row. Their proposal content was extracted from the
baked HTML via `parse_baked_proposal.py` and inserted as v1 rows.

## Artefacts

- `parse_baked_proposal.py` — extractor. Run against a baked
  `<slug>/proposal/index.html` and emits the `proposal_content` JSONB shape
  used by `api/generate-proposal.js`.
- `edward-chan.content.json`, `ray-miller.content.json` — extracted content,
  inlined into the migration verbatim.

## Timestamps

Original generation dates pulled from GitHub commit history for each file
(first commit touching the path):

| Slug         | contact_id                              | generated_at               |
| ------------ | --------------------------------------- | -------------------------- |
| edward-chan  | `7c400ad7-df9e-4e84-b2be-bf6a22b9da04`  | 2026-03-25 02:45:06 UTC    |
| ray-miller   | `2e88d8e9-321a-48f1-a513-c69c3569093a`  | 2026-03-26 21:43:49 UTC    |

## Re-running

The migration is idempotent on top of an empty state for these two slugs:
`INSERT INTO proposals ...` would violate `contacts(id)` uniqueness if those
contacts already had proposals rows. On replay you'd need to `DELETE` the
existing proposals first. This script is one-shot and should not be replayed
in production.
