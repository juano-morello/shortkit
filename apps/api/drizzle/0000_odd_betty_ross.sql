CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Appended by hand (TASK-005). Drizzle Kit generates no policy DDL, so every
-- statement below comes from docs/contracts/rls-policy-template.md, section
-- "The cascade root: tenants", and lands in the same commit as the table.
--
-- `tenants` carries `id`, not `tenant_id`, so tenantScopedPolicies() does not apply:
-- this is the bespoke four-policy set. FORCE matters as much as ENABLE: without it
-- shortkit_migrator, which owns the table, is exempt from all four.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenants" FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenants_self_select ON "tenants"
  FOR SELECT USING (id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY tenants_self_update ON "tenants"
  FOR UPDATE USING      (id = current_setting('app.tenant_id', true)::uuid)
             WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
-- Signup creates exactly the tenant whose context it is already in (ADR-0021).
CREATE POLICY tenants_self_insert ON "tenants"
  FOR INSERT WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
-- The only DELETE path on tenants, anywhere in the system. There is deliberately no
-- policy keyed on app.tenant_id for DELETE (F-005): an ordinary handler that issued
-- DELETE FROM tenants would otherwise cascade-destroy click_events and audit_entries
-- while setting no flag and passing through no eraser.
CREATE POLICY tenants_privileged_erase ON "tenants"
  FOR DELETE USING (id::text = current_setting('app.privileged_erase', true));
