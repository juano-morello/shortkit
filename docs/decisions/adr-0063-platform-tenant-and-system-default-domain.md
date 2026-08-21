---
id: ADR-0063
slug: links-redirect
title: The system default domain is a row owned by a seeded platform tenant, and links reach it through a foreign key the policies never see
status: accepted
supersedes: null
amends: null
depends_on: ADR-0003, ADR-0006, ADR-0016, ADR-0019, ADR-0021, ADR-0030, ADR-0034, ADR-0049, ADR-0062
date: 2026-08-19
amended: 2026-08-19 (review). The `links.domain_id` decision was replaced: the plain foreign
  key admitted a link naming another tenant's domain, measured, so `links` now carries
  `domain_tenant_id`, a composite key to `domains (id, tenant_id)` and `links_domain_owner_check`.
---

## Context

Item 2 ships a URL shortener on "the system default domain". `domain-provisioning.md` and
`redirect-resolution.md` were written in 2026-08 against a system where custom domains
already existed, and both reference the seeded row as a thing that is already there:
`resolveHost` serves only a `domains` row in state `active` (F-003), and the reserved
hostname table lists "the seeded system default domain" among the hostnames a customer may
not claim. Neither says who owns it.

That is the whole question, and it exists because of a rule this repository does not intend
to bend. ADR-0003's template gives every tenant-scoped table
`tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`, two policies keyed on
`app.tenant_id`, and no third state. `domains` is a tenant-scoped table.
`links.domain_id` is `NOT NULL`. So the hostname every link in item 2 resolves on must be a
`domains` row, and that row must have an owner.

The other constraints in force:

- **The redirect reads across tenants by design.** `app.redirect_context` is a `FOR SELECT`
  policy on `domains` and `links`, exclusion 1 of exactly 3, and its length is the control.
  Nothing here may add a fourth.
- **No deploy target (ADR-0030).** There is no production database to migrate, no data to
  preserve, and no operator to run a one-off script. The reset is
  `docker compose down -v` (ADR-0032).
- **F-236, measured.** A migration runs as `shortkit_migrator`: `NOBYPASSRLS`, under
  `FORCE ROW LEVEL SECURITY`, with no context flag set. An `INSERT` there is admitted by no
  policy, writes zero rows, and reports success. ADR-0062 recorded this for `memberships`'
  absent backfill, where the cost was a backfill nobody needed. Here it applies to the row
  every link's foreign key resolves against.
- **D-2-02, ruled by Juano on 2026-08-19.** The local hostname is `localhost` and short links
  are shown as `http://localhost:3001/<slug>`, the API's published compose port, because the
  redirect serves on the same process and port as the API (ADR-0006, one deployable).

## Decision

### The system default domain is an ordinary `domains` row owned by a seeded platform tenant

Three fixed uuids, frozen the way `DEMO_TENANT_ID` is frozen (ADR-0034), declared once in
`apps/api/src/db/platform.ts` and imported by everything that needs them: the API at
runtime, `scripts/seed.mts` at seed time:

| Constant | Value | Row |
|---|---|---|
| `PLATFORM_TENANT_ID` | `00000000-0000-4000-8000-00000000000f` | `tenants`, name `Shortkit platform` |
| `PLATFORM_WORKSPACE_ID` | `00000000-0000-4000-8000-00000000001f` | `workspaces`, name `Platform` |
| `SYSTEM_DEFAULT_DOMAIN_ID` | `00000000-0000-4000-8000-00000000002f` | `domains`, `state = 'active'`, `is_system_default = true` |

Version nibble 4 and variant nibble 8, so each passes any uuid validation the code applies,
and each is obviously synthetic to a human reading a row. The workspace exists because
`domains.workspace_id` is `NOT NULL` and its key is composite; no operator is ever a member
of it, and `memberships` gets no row.

`hostname` is `SYSTEM_DEFAULT_DOMAIN` normalised by `normaliseHostname`: lowercase, IDNA via
`new URL()`, port stripped. That is `redirect-resolution.md`'s decision-order step 1 and the
form `redirect-cache.md` keys on. Unset means `localhost` (D-2-02). No code keys on the
value; a real deployment sets the variable and the same rows carry the real hostname.

### The migration and the template are unchanged

Migration `0005` creates `domains`, `links` and `click_events` and hand-appends
`tenantScopedPolicies()` for all three, plus `redirectReadPolicy()` for `domains` and `links`,
the first applied instances of a builder that had none. No nullable owner column, no
`OR is_system_default` disjunct in a policy, no platform-specific predicate, no fourth
context flag, no fourth exclusion. The approved policy set in `rls-policy-template.md` is
satisfied exactly as written.

**The rows are written by the seed, as `shortkit_app`, inside a transaction that set
`app.tenant_id = PLATFORM_TENANT_ID` first**, a second per-tenant group beside the demo
tenant's, each unit ending `ON CONFLICT (id) DO NOTHING` (ADR-0034 rule 1). Two groups
because `app.tenant_id` names one tenant and `tenants_self_insert` admits exactly the tenant
whose context the insert runs in (ADR-0021): there is no single flag value under which both
tenants' rows are policy-correct.

### `links` names its domain as a pair: `(domain_id, domain_tenant_id)`, keyed and checked

*Rewritten 2026-08-19, after review, replacing the "plain foreign key" decision below.*

~~`links.domain_id REFERENCES domains(id) ON DELETE CASCADE`, and the isolation argument it
gives up is written down rather than assumed: a `links` row could name any tenant's domain and
the database would accept it. What bounds that today is that nothing can construct such a row:
`domainId` is not on the create body at all (D-2-12: it is always `SYSTEM_DEFAULT_DOMAIN_ID`),
and there is no second domain to name. Item 3, which is where a tenant-owned domain first
exists, owns the application check.~~

**That was a defect deferred, not a cost accepted, and the review measured it.** Against the
live database on 2026-08-19: tenant A inserted a `links` row naming tenant B's `domains` row,
and the redirect's own two permitted queries then served A's destination under B's hostname. A
could also take a slug on B's domain and hold it against B forever, because
`links_domain_id_slug_unique` is an index and an index is never policy filtered. "Nothing can
construct such a row" was a statement about the application, and the whole point of ADR-0062's
composite key is that the application is not what this schema relies on. Item 2 was safe only
because no second domain exists yet, and item 3 is the initiative that creates one.

The premise the struck passage rested on is still true: `(domain_id, tenant_id) -> domains (id,
tenant_id)` is impossible, because the system default domain belongs to the platform tenant and
that pair is not a row for any customer link. What was wrong is the conclusion that no
composite form exists. **The claim gets its own column.**

```sql
domain_tenant_id uuid NOT NULL

CONSTRAINT links_domain_tenant_fk
  FOREIGN KEY (domain_id, domain_tenant_id) REFERENCES domains (id, tenant_id) ON DELETE CASCADE

CONSTRAINT links_domain_owner_check
  CHECK (domain_tenant_id = tenant_id OR domain_tenant_id = '<PLATFORM_TENANT_ID>')
```

`domain_tenant_id` is the tenant the writer claims owns the domain it is naming. The key makes
the claim true: referential integrity is not policy filtered, so the pair has to be a real
`domains` row, and a writer naming B's domain must write B's tenant id beside it. The check
then narrows "a real pair" to "a pair this tenant may use": its own tenant's domain, or the
shared platform default, and nothing else.

**Neither constraint alone closes it, which is why both are here.** The key alone still admits
A pointing at B's domain while telling the truth about who owns it. The check alone still
admits A pointing at B's domain while claiming to own it, since `domain_tenant_id = tenant_id`
would be satisfied. Together they leave exactly the two legitimate cases. The target of the
key is `domains_id_tenant_unique`, the constraint this ADR already added for item 3 and
described as unused.

**What is still shared, stated so this is not read as more than it is.** Uniqueness stays
`(domain_id, slug)`, so on the one domain every tenant legitimately shares, a slug taken by any
tenant is taken for all of them. That is the contract rather than a residue: `slug.md` scopes
uniqueness to the domain, and AC-2-3 says a slug already taken on the system default domain by
any tenant answers 409 `slug_taken`.

**What the create path owes.** Both columns on every insert. For item 2 that is always the pair
`SYSTEM_DEFAULT_DOMAIN_ID` and `PLATFORM_TENANT_ID`, the two frozen constants in
`db/platform.ts`. TASK-2-05 is unbuilt, so this costs no rework.

**What item 3 inherits.** A schema that already refuses the cross-tenant reference, so the
application check that decision deferred is a defence in depth rather than the only defence.
Adding a tenant-owned domain to the create body means passing the owning tenant's id beside it,
and the database refuses the pair if the caller gets it wrong.

## The measurement this rests on

**Referential checks run with row security bypassed.** So the foreign key from a customer's
link to the platform's domain resolves even though the customer's transaction cannot read
that row, and the row's contents never reach the transaction. Measured directly in
`apps/api/test/db/migration-0005.int-spec.ts`, as `shortkit_app` inside an ordinary tenant
transaction:

```
select id from domains where id = <a domain owned by another tenant>   -> 0 rows
insert into links (..., domain_id = that same id, ...)                 -> 1 row, tenant_id = the actor's
```

It is the same property 1b measured from the other side: ADR-0062's composite key exists
*because* a plain FK is satisfied by any tenant's workspace id, the referential check having
bypassed the policy that hides it. One fact, two consequences: a hazard where the reference
should have been tenant-bounded, and the mechanism where it deliberately crosses.

**And the same property is what closes the hazard**, which is the part the first version of
this ADR missed. Because the check is not policy filtered, it also cannot be fooled by a
writer who cannot see the row: `(B's domain, A)` is not a `domains` row, and no statement A is
allowed to issue can make it one. Measured on the same database and in the same file, as
`shortkit_app` inside an ordinary tenant transaction:

```
insert into links (..., domain_id = <B's domain>, domain_tenant_id = <B>, ...)  -> 23514 links_domain_owner_check
insert into links (..., domain_id = <B's domain>, domain_tenant_id = <A>, ...)  -> 23503 links_domain_tenant_fk
insert into links (..., domain_id = <A's domain>, domain_tenant_id = <platform>) -> 23503 links_domain_tenant_fk
insert into links (..., domain_id = <system default>, domain_tenant_id = <A>)   -> 23503 links_domain_tenant_fk
update links set domain_id = <B's domain>, domain_tenant_id = <B>               -> 23514
update links set domain_id = <B's domain>, domain_tenant_id = <A>               -> 23503
```

The two admitted shapes, in the same run: a link on the system default domain carrying the two
frozen constants, and a link on a domain the same tenant owns. `migration-0005.int-spec.ts`
holds all of it, and dropping either constraint turns a named test red rather than leaving the
suite green.

## Consequences, stated

**No customer transaction can read the platform row, and nothing needs it to.** Link creation
references it by FK; the API denormalises `hostname` from `SYSTEM_DEFAULT_DOMAIN` into
`linkContract` and `LinkSnapshot` (D-2-19) rather than reading it back; the redirect reads it
under `app.redirect_context` like any domain. `seed-platform.int-spec.ts` asserts the zero-row
read as a *requirement*.

**The named failure mode: a repository test "fixing" the invisible row.** A `LinkRepository`
test that joins `domains` to return the hostname will see zero rows and look broken. Widening
`domains_tenant_isolation`, adding an `OR is_system_default` disjunct, or giving
`app.redirect_context` a second reader all make it green, and all three are cross-tenant
reads. The remedy is the denormalisation above, which is why D-2-19 put `hostname` on the wire
in the first place.

**The platform tenant appears in `tenants` everywhere it is enumerated**: the isolation
suite's five-property database cross-check, `tenantScopedTables()`, a future GDPR export. The
isolation fixtures never mint it as an actor and the fixture never seeds it, so the harness's
attempts are between two customer tenants as before. A future `POST /api/gdpr/delete` can no
more erase it than any tenant can erase another: the eraser's policy compares `tenant_id` to
the flag, and no signup can produce this id.

**`domain-provisioning.md` already reserves the seeded hostname from customer claims**, so no
tenant can claim it in item 3, and `resolveHost`'s `state = 'active'` predicate is the second
independent defence.

**`click_events` still names its link and its domain through plain single-column keys.** Its
rows are written only by the flusher, from a link the redirect already resolved, so there is no
writer that could name another tenant's link today. That is the same class of argument this ADR
just had to withdraw for `links`, and it is recorded here rather than left implicit: the card
that builds the click write path (TASK-2-09) owns the decision to key it as a pair or to write
down why it need not be.

**The seed became load-bearing.** It was demo data nothing depended on; it now writes the rows
without which `POST /api/links` answers 23503 and `GET /:slug` answers 404 for every slug.
That is why `seed.mts` gained an entry-point guard and an integration suite that drives the
real units, so the statements under test are the shipped ones rather than a fixture's copy.

## Alternatives rejected

**A nullable `domains.tenant_id`, with the policy admitting `tenant_id IS NULL`.** This is the
shape the question invites, and the one to refuse. It changes the template for
every reader, it puts a disjunct in a policy that ADR-0049's counting control would then have
to reason about, it makes `tenant_id IS NULL` a row the erasure cascade never reaches
(ADR-0019), and the widened predicate would be inherited by whoever copies the template next.
The approved policy set exists so that a policy is checkable by name and by `qual` text; a
per-table exception is exactly what it forbids.

**A separate `system_domains` table with no RLS.** No policy to widen, but `links.domain_id`
would then have to reference one of two tables through a polymorphic key, a check constraint
or a union view, and item 3's first tenant-owned domain would need a migration moving rows
between them. The redirect's permitted query shape (`SELECT ... FROM domains WHERE hostname =
$1 AND state = 'active'`, grep-asserted) would become two shapes or a view, and the GC-N
assertion that counts them would have to be relaxed.

**Seeding from migration `0005`.** One line instead of a transaction, and it writes nothing:
F-236, above. The migration is green, the tables are correct, and the failure surfaces as a
foreign-key violation in whichever feature runs first.

**A boot-time upsert in the API.** It would run as `shortkit_app` with a flag it can set, so
it would work. It would also put a write on the boot path, make "did the API start" depend on
"could the API write", and give the platform row a second writer that disagrees with the seed
about the hostname whenever `SYSTEM_DEFAULT_DOMAIN` differs between the two processes.
ADR-0033 already decided that seeding is the `seed` service's job, ordered before `api`.

**Generating the uuids rather than freezing them.** The API needs `SYSTEM_DEFAULT_DOMAIN_ID`
as a compile-time constant to write `domain_id` on every link without a lookup on the create
path. A generated id would need a read, of a row the creating transaction cannot see.

## What would reopen this

A second system-owned domain (a second brand, a regional hostname); the first tenant-owned
domain reaching `active`, which is item 3 and which brings the application check this ADR
defers; or a deploy target (superseding ADR-0030) that makes "run the seed once, correctly,
against a database with rows in it" a real operational question rather than a
`docker compose down -v`.
