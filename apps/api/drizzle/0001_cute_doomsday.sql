CREATE TYPE "public"."tenant_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "tenant_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_memberships_user_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ===========================================================================
-- EVERYTHING BELOW IS APPENDED BY HAND (TASK-002). Drizzle Kit generates no
-- policy DDL and no GRANT, so the three things this table owes (its column,
-- its policies and its registry entry) land in this one commit or the table
-- is writable by every tenant from the moment it exists (GC-A, F-239).
--
-- Every statement comes from a function or a contract, never typed twice:
--   tenantScopedPolicies('tenant_memberships') and membershipLookupPolicy()
--   in apps/api/src/db/rls.ts, and docs/contracts/rls-policy-template.md.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. tenant_memberships: tenantScopedPolicies('tenant_memberships')
-- ---------------------------------------------------------------------------
-- FORCE matters as much as ENABLE: shortkit_migrator owns this table and would
-- otherwise be exempt from the policies it just created.
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_memberships FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_memberships_tenant_isolation ON tenant_memberships
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_memberships_privileged_erase ON tenant_memberships
  FOR DELETE
  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));--> statement-breakpoint
CREATE INDEX tenant_memberships_tenant_id_idx ON tenant_memberships (tenant_id);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. tenant_memberships: membershipLookupPolicy(), ADR-0045
-- ---------------------------------------------------------------------------
-- The token-mint escape, and the third and last exception to GC-5. FOR SELECT
-- only, and it stays FOR SELECT: it admits the single row whose user_id equals
-- app.membership_lookup_user, which withMembershipLookup sets inside a READ
-- ONLY transaction in one file. PostgreSQL ORs permissive policies, so this
-- adds visibility to the isolation policy beside it and never widens a write.
CREATE POLICY tenant_memberships_membership_lookup ON tenant_memberships
  FOR SELECT
  USING (user_id = nullif(current_setting('app.membership_lookup_user', true), ''));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. tenants: FOUR policies dropped and recreated in the nullif form, ADR-0049
-- ---------------------------------------------------------------------------
-- A REVIEWER SEEING `DROP` IN A GENERATED MIGRATION IS TOLD BY ADR-0004 TO STOP
-- AND ASK FOR THE ADR. It is ADR-0049. No column, table or row is destroyed, so
-- the forward-only rule still holds; migration 0000 is applied and is not edited.
--
-- WHY: a transaction-local set_config leaves a session placeholder whose reset
-- value is the EMPTY STRING, not NULL, and pg.Pool issues no reset. From the
-- first committed tenant transaction onward every later checkout of that backend
-- reads '', so `''::uuid` is evaluated and the statement raises 22P02: AC-10's
-- own out-of-context read failing on the only connection state the application
-- actually runs in. `nullif(<flag>, '')` collapses unset and reset to NULL alike.
--
-- FOUR, NOT THREE (F-029). tenants_privileged_erase never casts and never raised;
-- it is rewritten for the rule rather than for the bug, because db:check-policies
-- counts wrappers mechanically over every row of pg_policies and "untouched" reads
-- as "rejected". Between its DROP and its CREATE there is no DELETE policy on
-- tenants at all, which is fail-closed and is why the two are adjacent.
DROP POLICY tenants_self_select ON "tenants";--> statement-breakpoint
CREATE POLICY tenants_self_select ON "tenants"
  FOR SELECT USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY tenants_self_update ON "tenants";--> statement-breakpoint
CREATE POLICY tenants_self_update ON "tenants"
  FOR UPDATE USING      (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
             WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY tenants_self_insert ON "tenants";--> statement-breakpoint
CREATE POLICY tenants_self_insert ON "tenants"
  FOR INSERT WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY tenants_privileged_erase ON "tenants";--> statement-breakpoint
CREATE POLICY tenants_privileged_erase ON "tenants"
  FOR DELETE USING (id::text = nullif(current_setting('app.privileged_erase', true), ''));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. The role split: ADR-0050
-- ---------------------------------------------------------------------------
-- session.token is the session credential, in plaintext. Measured from an
-- ordinary tenant-A transaction as shortkit_app before this statement: INSERT of
-- a session row with an attacker-chosen token for another tenant's user, UPDATE
-- of that user's password hash, UPDATE of their email. The blast radius of a SQL
-- defect in apps/api was account takeover, not credential disclosure.
--
-- IT CANNOT BE EXPRESSED AS A DEFAULT PRIVILEGE. `ALTER DEFAULT PRIVILEGES FOR
-- ROLE shortkit_migrator ... GRANT ... TO shortkit_app` grants DML on every table
-- the migrator creates, forever, including these five, so the split is per-table,
-- hand-written, and forgetting it fails OPEN. check-policies.mts's grant matrix,
-- in both directions, is what catches that; it runs in CI's integration job.
--
-- shortkit_auth is created by TASK-018 in wave 0. This migration does not create
-- it: a GRANT against a role that does not exist fails here, at migration time.
--
-- DO NOT DELETE THE REVOKE TO MAKE SIGN-IN WORK. If Better Auth cannot read
-- "user", the answer is DATABASE_AUTH_URL and the auth pool in db/client.ts:
-- one pool on DATABASE_URL connects as shortkit_app, which this statement has
-- just revoked.
REVOKE ALL PRIVILEGES ON "user", "session", "account", "verification", "jwks"
  FROM shortkit_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", "session", "account", "verification", "jwks"
  TO shortkit_auth;