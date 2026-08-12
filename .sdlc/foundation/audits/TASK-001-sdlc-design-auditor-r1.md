# TASK-001 — UI/design audit (round 1)

## Design source

No Figma link in TASK-001.md or STORY-001.md. No design system exists yet in
this repo (no token files, no component library, no CSS/Tailwind config
anywhere in the diff). STORY-001's five ACs (AC-1, AC-2, AC-3, AC-4, AC-107)
are all about tooling (install/lint/typecheck/test/build) and none describe a
visual outcome. Audited against: plain HTML semantics and baseline
accessibility only, per the task brief's own framing of this as bootstrap
scaffolding.

## Scope actually audited

The only user-facing surface in the diff:

- `apps/web/app/layout.tsx` (root layout — inherited by every future page)
- `apps/web/app/page.tsx` (placeholder home page)
- `apps/web/app/not-found.tsx` (placeholder 404, explicitly not the branded
  404 — that is TASK-046's)
- `apps/web/app/not-found.spec.tsx` (test, read for context only)

Everything else in the diff (`apps/api/**`, `packages/contracts/**`, root
tooling config, README) has no UI surface and was not audited here.

## Findings

None.

Checked specifically for the failure modes the task brief flagged as likely,
since those are the ones expensive to unwind once later TASKs build on this
root layout:

- **`lang` attribute** — `layout.tsx` sets `<html lang="en">`. This is a
  reasonable default (no i18n requirement anywhere in STORY-001/TASK-001) and
  not an accidental value; not flagging.
- **Font/colour decisions** — none were made. No `next/font` import, no
  `globals.css`, no Tailwind config, no inline styles, no CSS at all in the
  diff. There is nothing here for a later TASK to fight or un-hardcode.
- **Metadata** — `layout.tsx` exports `title` and `description`. Present,
  not missing.
- **Semantic structure** — `layout.tsx` renders `<html><body>{children}</body></html>`
  with no extraneous wrapper; `page.tsx` and `not-found.tsx` each use a single
  `<main>` landmark with one `<h1>`. No duplicate landmarks, no heading-order
  violations, nothing that later pages would have to route around.
- **Contrast/theme** — no colors are set anywhere, so there is nothing to
  break in either theme; this is inert until a real design system lands.
- **Keyboard/focus** — none of the three files render an interactive control
  (no links, buttons, or forms), so there is no focus/keyboard surface to
  audit yet.

One thing considered and deliberately not raised as a finding:
`not-found.tsx` renders the raw numeric HTTP status (`{ERROR_CODE_STATUS.not_found}`,
i.e. `404`) as the `<h1>` text, with "No page lives at this address." as the
explanation. That is technically a real interstitial a visitor can hit today
(Next's App Router serves this on any unmatched `/` route in `apps/web`), so
it's not purely inert. But TASK-001's brief is explicit that this component is
not the branded 404 experience — that ships in TASK-046 — and the page is
otherwise semantically sound (one h1, one paragraph, no broken landmarks, no
misleading content). Treating a placeholder's copy choice as a design defect
here would be manufacturing a finding against scaffolding the brief already
told me to expect clean. Flagging it only as something for TASK-046 to be
aware of, not as a finding against this TASK.

## States not implemented

Not applicable. Three static, stateless pages with no data fetching, no
forms, no async behavior — there are no loading/error/empty/disabled states
for this TASK to have skipped.

## Verdict

Approved — no UI-surface findings. The bootstrap web workspace is
deliberately minimal, ships no design-system decisions to violate (no colors,
fonts, or component reimplementations), and the root layout it hands to later
TASKs is a clean, unopinionated `<html lang="en"><body>{children}</body></html>`
with correct metadata. Nothing here is expensive to change later.
