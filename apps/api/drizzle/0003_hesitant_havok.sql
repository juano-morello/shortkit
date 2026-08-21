CREATE TYPE "public"."invitation_state" AS ENUM('pending', 'accepted', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('workspace_admin', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "invitation_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" "workspace_role" NOT NULL,
	CONSTRAINT "invitation_workspaces_invitation_workspace_unique" UNIQUE("invitation_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"state" "invitation_state" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"inviter_email" text NOT NULL,
	"accepted_by_user_id" text,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "workspace_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_user_unique" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
-- REORDERED BY HAND (TASK-1b-03): Drizzle Kit emits this constraint LAST, after the two
-- composite foreign keys that reference it, and PostgreSQL refuses a FOREIGN KEY whose
-- referenced columns carry no unique constraint yet. The statement is the generator's,
-- unchanged; only its position moved. It is the ONLY change 1b makes to `workspaces`: a
-- constraint, not a column and not a policy (ADR-0062). Migration 0002 is untouched.
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_id_tenant_unique" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "invitation_workspaces" ADD CONSTRAINT "invitation_workspaces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_workspaces" ADD CONSTRAINT "invitation_workspaces_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_workspaces" ADD CONSTRAINT "invitation_workspaces_workspace_tenant_fk" FOREIGN KEY ("workspace_id","tenant_id") REFERENCES "public"."workspaces"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_tenant_fk" FOREIGN KEY ("workspace_id","tenant_id") REFERENCES "public"."workspaces"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_digest_unique" ON "invitations" USING btree ("token_digest");--> statement-breakpoint
-- ===========================================================================
-- EVERYTHING BELOW IS APPENDED BY HAND (TASK-1b-03). Drizzle Kit generates no
-- policy DDL, so the three things each of these tables owes (its column, its
-- policies and its registry entry) land in this one commit or the table is
-- writable by every tenant from the moment it exists (GC-A, F-239): ALTER
-- DEFAULT PRIVILEGES already granted shortkit_app full DML on all three.
--
-- Three blocks, in this order: tenantScopedPolicies('memberships'),
-- tenantScopedPolicies('invitations'), tenantScopedPolicies('invitation_workspaces')
-- from apps/api/src/db/rls.ts, each verbatim: the template UNCHANGED, because
-- all three are template-shaped tables and none is a cascade root. NO BESPOKE
-- POLICY ON ANY OF THEM: the @Public() invitation lookup reads `invitations`
-- inside withTenantTransaction(<token's tenant prefix>) under the ordinary
-- isolation policy (ADR-0021, "not a GC-5 escape"), so ISOLATION_EXCLUSIONS
-- stays at three. test/db/migration-0003.int-spec.ts compares each block against
-- the function's output and against pg_policies, so a drift between the three
-- fails a test rather than shipping. `workspaces` gets no policy change here.
--
-- NO BACKFILL of `memberships` for workspaces that already exist (ADR-0062,
-- D-10): the migrator is NOBYPASSRLS under FORCE ROW LEVEL SECURITY with no
-- app.tenant_id set, so an INSERT ... SELECT here would read zero rows, insert
-- nothing and report success: F-236's shape. The remedy for a compose volume
-- carrying 1a rows is the reset (docker compose down -v, ADR-0032).
-- ===========================================================================
-- FORCE matters as much as ENABLE: shortkit_migrator owns these tables and would
-- otherwise be exempt from the policies it just created.
-- ---------------------------------------------------------------------------
-- tenantScopedPolicies('memberships'), verbatim.
-- ---------------------------------------------------------------------------
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE memberships FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY memberships_tenant_isolation ON memberships
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY memberships_privileged_erase ON memberships
  FOR DELETE
  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));--> statement-breakpoint
CREATE INDEX memberships_tenant_id_idx ON memberships (tenant_id);--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- tenantScopedPolicies('invitations'), verbatim.
-- ---------------------------------------------------------------------------
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invitations FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY invitations_tenant_isolation ON invitations
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY invitations_privileged_erase ON invitations
  FOR DELETE
  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));--> statement-breakpoint
CREATE INDEX invitations_tenant_id_idx ON invitations (tenant_id);--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- tenantScopedPolicies('invitation_workspaces'), verbatim.
-- ---------------------------------------------------------------------------
ALTER TABLE invitation_workspaces ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invitation_workspaces FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY invitation_workspaces_tenant_isolation ON invitation_workspaces
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY invitation_workspaces_privileged_erase ON invitation_workspaces
  FOR DELETE
  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));--> statement-breakpoint
CREATE INDEX invitation_workspaces_tenant_id_idx ON invitation_workspaces (tenant_id);
