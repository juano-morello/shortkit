---
id: STORY-015
epic: EPIC-004
title: Automated TLS provisioning
status: deferred
tasks: [TASK-042, TASK-043, TASK-044]
depends_on: [STORY-014]
---

## User story

As an agency operator, my verified client domain starts serving HTTPS without me or Juano touching anything.

## Acceptance criteria

- [ ] AC-70: **(SC-4)** Given a domain reaches verified state, when no human action is taken, then within the documented provisioning window the domain's state becomes `active` and a certificate is issued for it.
- [ ] AC-71: **(SC-4)** Given an active custom domain and an active link on it, when `https://<custom-domain>/<slug>` is requested from outside the network, then TLS negotiates successfully and the response is a 302 to the destination.
- [ ] AC-72: Given certificate provisioning fails, when the domain is read via the API and displayed in the UI, then its state is `failed`, an actionable reason is shown, and a retry action is available that re-attempts provisioning.
- [ ] AC-73: Given a domain is deleted, when its hostname is subsequently requested, then it no longer resolves to a working redirect for that tenant, and the certificate/hostname binding is released.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**BLOCKED on dispatch — genuinely, in full.** AC-71 is an external HTTPS request to a hostname Juano must own, and AC-70 exercises Fly's real certificate API. Faking either would test the mock.

These are the only three hard-blocked TASKs in the plan (042 → 043 → 044, serial). Additionally, **Fly's certificate API has unpublished quotas** for large numbers of custom hostnames — confirm behaviour before TASK-042 dispatches.

- [x] ACs are testable and unambiguous
- [x] Dependencies identified
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run yet
- [x] No blocking open questions

## Definition of Done
- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids
