CREATE TYPE "public"."domain_state" AS ENUM('pending_verification', 'verified', 'provisioning', 'active', 'verification_failed', 'certificate_failed');--> statement-breakpoint
CREATE TABLE "click_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ip_hash" text NOT NULL,
	"user_agent" varchar(512)
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"state" "domain_state" NOT NULL,
	"is_system_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_id_tenant_unique" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"domain_tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"destination_url" text NOT NULL,
	"expires_at" timestamp with time zone,
	"activates_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "links_domain_id_slug_unique" UNIQUE("domain_id","slug"),
	CONSTRAINT "links_domain_owner_check" CHECK (domain_tenant_id = tenant_id or domain_tenant_id = '00000000-0000-4000-8000-00000000000f'::uuid)
);
--> statement-breakpoint
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_workspace_tenant_fk" FOREIGN KEY ("workspace_id","tenant_id") REFERENCES "public"."workspaces"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_workspace_tenant_fk" FOREIGN KEY ("workspace_id","tenant_id") REFERENCES "public"."workspaces"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_domain_tenant_fk" FOREIGN KEY ("domain_id","domain_tenant_id") REFERENCES "public"."domains"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "click_events_link_occurred_idx" ON "click_events" USING btree ("link_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "click_events_domain_id_idx" ON "click_events" USING btree ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_hostname_owned_unique" ON "domains" USING btree ("hostname") WHERE state in ('verified', 'provisioning', 'active');--> statement-breakpoint
CREATE INDEX "domains_workspace_id_idx" ON "domains" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "links_workspace_created_idx" ON "links" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "links_domain_tenant_id_idx" ON "links" USING btree ("domain_tenant_id");--> statement-breakpoint
-- ===========================================================================
-- EVERYTHING BELOW IS APPENDED BY HAND (TASK-2-02). Drizzle Kit generates no
-- policy DDL, so the three things each of these tables owes (its column, its
-- policies and its registry entry) land in this one commit or the table is
-- writable by every tenant from the moment it exists (GC-A, F-239): ALTER
-- DEFAULT PRIVILEGES already granted shortkit_app full DML on all three.
--
-- FIVE BLOCKS, IN THIS ORDER, each verbatim from apps/api/src/db/rls.ts:
--   tenantScopedPolicies('domains')
--   redirectReadPolicy('domains')      <- FIRST APPLIED INSTANCE
--   tenantScopedPolicies('links')
--   redirectReadPolicy('links')        <- FIRST APPLIED INSTANCE
--   tenantScopedPolicies('click_events')
-- test/db/migration-0005.int-spec.ts compares this file against the builders'
-- output and against pg_policies, so a drift between the three fails a test
-- rather than shipping.
--
-- THE TWO redirect_read POLICIES ARE THE FIRST INSTANCES EVER APPLIED. Until
-- this migration, rls.ts and rls-policy-template.md both said the policy "has
-- no applied instance: domains and links do not exist yet"; both sentences are
-- corrected in this commit. They land HERE rather than with TASK-2-06's
-- withRedirectRead for GC-A's reason as amended for item 2: a table the
-- redirect can read before its escape policy exists would simply read nothing,
-- but a policy appended in a LATER migration is a second F-239 window.
--
-- FOR SELECT, on these two tables only, keyed on app.redirect_context, which
-- exactly one file will ever set (withRedirectRead, TASK-2-06, which
-- additionally issues SET TRANSACTION READ ONLY). click_events takes the
-- template and nothing else: the redirect never reads it, and the click flush
-- runs inside withTenantTransaction under the ordinary isolation policy, so click
-- emission is NOT a GC-5 exclusion, and ISOLATION_EXCLUSIONS stays at three.
--
-- ON THE GENERATED HALF, BECAUSE A READER OF THIS FILE WILL ASK. `links` carries
-- `domain_tenant_id` beside `domain_id`, a composite key `(domain_id, domain_tenant_id)
-- -> domains (id, tenant_id)`, and `links_domain_owner_check`. Those are the generator's
-- statements, from `src/db/schema/links.ts`, and they are what stops one tenant naming
-- another tenant's domain: measured on 2026-08-19, the earlier plain `domain_id` key let
-- tenant A create a link on tenant B's domain and the redirect served A's destination under
-- B's hostname. Referential integrity is not policy filtered, so the pair has to be a real
-- `domains` row; the check narrows the admitted pairs to the row's own tenant and the
-- platform default. The schema file carries the full reasoning and ADR-0063 the amendment.
--
-- NO SEED HERE, AND THAT IS F-236 (ADR-0063). The platform tenant, the platform
-- workspace and the system default domain row are written by scripts/seed.mts as
-- shortkit_app inside a transaction that set app.tenant_id first. An INSERT in
-- this file would run as shortkit_migrator, which is NOBYPASSRLS under FORCE ROW
-- LEVEL SECURITY with no context flag set: it would insert ZERO ROWS and report
-- success.
-- ===========================================================================
-- FORCE matters as much as ENABLE: shortkit_migrator owns these tables and would
-- otherwise be exempt from the policies it just created.
-- ---------------------------------------------------------------------------
-- tenantScopedPolicies('domains'), verbatim.
-- ---------------------------------------------------------------------------
ALTER TABLE domains ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE domains FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY domains_tenant_isolation ON domains
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY domains_privileged_erase ON domains
  FOR DELETE
  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));--> statement-breakpoint
CREATE INDEX domains_tenant_id_idx ON domains (tenant_id);--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- redirectReadPolicy('domains'), verbatim. Exclusion 1 of exactly 3, applied.
-- ---------------------------------------------------------------------------
CREATE POLICY domains_redirect_read ON domains
  FOR SELECT
  USING (nullif(current_setting('app.redirect_context', true), '') = 'on');--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- tenantScopedPolicies('links'), verbatim.
-- ---------------------------------------------------------------------------
ALTER TABLE links ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE links FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY links_tenant_isolation ON links
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY links_privileged_erase ON links
  FOR DELETE
  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));--> statement-breakpoint
CREATE INDEX links_tenant_id_idx ON links (tenant_id);--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- redirectReadPolicy('links'), verbatim.
-- ---------------------------------------------------------------------------
CREATE POLICY links_redirect_read ON links
  FOR SELECT
  USING (nullif(current_setting('app.redirect_context', true), '') = 'on');--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- tenantScopedPolicies('click_events'), verbatim. No bespoke policy.
-- ---------------------------------------------------------------------------
ALTER TABLE click_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE click_events FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY click_events_tenant_isolation ON click_events
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY click_events_privileged_erase ON click_events
  FOR DELETE
  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));--> statement-breakpoint
CREATE INDEX click_events_tenant_id_idx ON click_events (tenant_id);
