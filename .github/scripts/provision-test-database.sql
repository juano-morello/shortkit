-- The roles, database and grants the `integration` job's Postgres service needs.
--
-- Contract: docs/contracts/rls-policy-template.md ("Roles")
-- ADR: docs/decisions/adr-0003-rls-policy-template-and-roles.md
--
-- Both paths are written out in full because the bare `docs/contracts/...` form used
-- across apps/ and packages/ does not resolve from the repository root: there is no
-- top-level `design/`. That short form is a repo-wide convention in files this TASK does
-- not own; it is reported rather than half-corrected here.
-- Produced by: TASK-002 (F-039)
--
-- WHY THIS FILE EXISTS SEPARATELY FROM docker-compose.test.yml. The local counterpart
-- bakes the same SQL into the container through Compose's `configs:` block, which drops
-- it into /docker-entrypoint-initdb.d before the real server starts. GitHub Actions'
-- `services:` has no equivalent: a service is a bare image plus env vars and health
-- options, with nowhere to put an init script. So the `integration` job stands the
-- service up on the bootstrap superuser alone and runs this file against it as a step.
--
-- THAT MEANS TWO COPIES OF THE ROLE MODEL, AND THEY CAN DRIFT. If you change the roles
-- or grants here, change docker-compose.test.yml in the same commit, and the other way
-- round. Both are applications of rls-policy-template.md's "Roles" section, which is
-- the thing they must both keep agreeing with.
--
-- TEST-ONLY. DO NOT ADAPT INTO A PRODUCTION DATABASE. The literal passwords below are
-- fixtures for a container that is destroyed with the runner; the same file shape
-- against a real database would commit real credentials. Provisioning the production
-- roles is not this file's job.

-- NOBYPASSRLS on all three roles, written out although it is the default. A role that
-- can bypass row-level security turns every isolation assertion in the suite into a
-- tautology, and the assertions further down are what stop this file from being the
-- place that silently happens.
CREATE ROLE shortkit_migrator LOGIN PASSWORD 'migrator' NOBYPASSRLS;
CREATE ROLE shortkit_app      LOGIN PASSWORD 'app'      NOBYPASSRLS;
-- shortkit_auth: runtime, Better Auth only. Owns nothing (ADR-0050).
CREATE ROLE shortkit_auth     LOGIN PASSWORD 'auth'     NOBYPASSRLS;

-- The migrator owns the database, so it owns schema `public` through pg_database_owner
-- and runs DDL with no further grant. The app role owns nothing (ADR-0003).
CREATE DATABASE shortkit_test OWNER shortkit_migrator;

-- The two properties the whole tenancy guarantee rests on, asserted rather than assumed.
-- A CREATE ROLE that quietly inherited an attribute from a template, or a future edit
-- that adds SUPERUSER "just for CI", fails this step instead of producing a green
-- integration run that proves nothing.
DO $$
DECLARE
  bad text;
BEGIN
  -- rls-policy-template.md: "Neither shortkit_app nor shortkit_auth may hold BYPASSRLS,
  -- SUPERUSER, CREATEROLE or table ownership." Three of the four are checked here; table
  -- ownership is checked downstream, per role, and NOT by check-policies.mts, which holds
  -- no ownership read at all. For shortkit_app it is the boot check,
  -- assertRuntimeRoleCannotBypassRls (apps/api/src/db/rls.ts), which reads
  -- tables_owned_in_public for current_user. For shortkit_auth the equivalent boot check
  -- is assertAuthRoleSeparation (ADR-0050, TASK-004, wave 3); until it lands this file's
  -- own suite covers it at the two live-database sites
  -- (auth-role-provisioning.int-spec.ts, "shortkit_auth owns no relation in the migrated
  -- schema"). CREATEROLE cannot escalate to the other two on PostgreSQL 16+ (the server
  -- closes that path), and it is listed because this block is the contract's only
  -- mechanical reader and was two words short of matching it.
  SELECT string_agg(rolname, ', ')
    INTO bad
    FROM pg_roles
   WHERE rolname IN ('shortkit_app', 'shortkit_migrator', 'shortkit_auth')
     AND (rolbypassrls OR rolsuper OR rolcreaterole);

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'role(s) % hold BYPASSRLS, SUPERUSER or CREATEROLE. The first two exempt a role from row-level security, so every isolation assertion in the integration suite would pass without proving anything (ADR-0003, rls-policy-template.md).',
      bad;
  END IF;

  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('shortkit_app', 'shortkit_migrator', 'shortkit_auth')) <> 3 THEN
    RAISE EXCEPTION
      'shortkit_app, shortkit_migrator and shortkit_auth must all exist and be distinct roles: the migrator owns the schema, the app role owns nothing and the auth role owns nothing (ADR-0003, ADR-0050).';
  END IF;

  IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'shortkit_test')
     IS DISTINCT FROM 'shortkit_migrator' THEN
    RAISE EXCEPTION
      'shortkit_test is not owned by shortkit_migrator. ALTER DEFAULT PRIVILEGES below is scoped to that identity, so the app role would receive no grant on migrated tables.';
  END IF;
END $$;

\connect shortkit_test

GRANT USAGE ON SCHEMA public TO shortkit_app, shortkit_auth;

-- Scoped to the identity `shortkit_migrator`: tables created by any other role grant
-- shortkit_app nothing. That fails closed, at runtime rather than here.
--
-- shortkit_auth gets no ALTER DEFAULT PRIVILEGES of its own, in either direction: a
-- default privilege for shortkit_auth would grant it DML on every table the migrator
-- creates, including every tenant-scoped one, so the split cannot be expressed as a
-- default privilege at all (rls-policy-template.md "Roles", ADR-0050). shortkit_auth's
-- DML on the five Better Auth tables is hand-written per table in migration 0001
-- (TASK-002) instead.
ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shortkit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shortkit_app;
