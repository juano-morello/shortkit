CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ===========================================================================
-- EVERYTHING BELOW IS APPENDED BY HAND (TASK-011). Drizzle Kit generates no
-- policy DDL, so the three things this table owes — its column, its policies
-- and its registry entry — land in this one commit or the table is writable by
-- every tenant from the moment it exists (GC-A, F-239): ALTER DEFAULT
-- PRIVILEGES already granted shortkit_app full DML on it.
--
-- Every statement below is tenantScopedPolicies('workspaces') from
-- apps/api/src/db/rls.ts, verbatim — the template unchanged, because
-- workspaces is a template-shaped table and not a cascade root. The workspace
-- integration suite compares this block against the function's output and
-- against pg_policies, so a drift between the three fails a test rather than
-- shipping (docs/contracts/workspaces.md).
-- ===========================================================================
-- FORCE matters as much as ENABLE: shortkit_migrator owns this table and would
-- otherwise be exempt from the policies it just created.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE workspaces FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY workspaces_tenant_isolation ON workspaces
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY workspaces_privileged_erase ON workspaces
  FOR DELETE
  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));--> statement-breakpoint
CREATE INDEX workspaces_tenant_id_idx ON workspaces (tenant_id);
