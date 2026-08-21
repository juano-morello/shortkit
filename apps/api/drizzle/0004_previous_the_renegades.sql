-- Debt sweep 2026-08-19 (ledger 1b-W1-11): leading-column indexes for the four foreign
-- keys migration 0003 left unindexed: memberships.user_id (only the SECOND column of
-- its UNIQUE), invitations.invited_by_user_id and invitations.accepted_by_user_id (no
-- index at all), invitation_workspaces.workspace_id (second column of its UNIQUE). They
-- serve the `"user"` referential actions (CASCADE / SET NULL), the composite-FK cascade
-- from `workspaces`, and `listForUser`'s membership join (TASK-1b-06).
--
-- NO HAND-APPENDED POLICY BLOCK, AND THAT IS CORRECT: not an omission of the 0003 kind.
-- The GC-A / F-239 obligation (column + policies + registry entry in ONE commit) binds a
-- migration that CREATES a table; this one creates none. All three tables here got their
-- `tenantScopedPolicies()` blocks in migration 0003, `test/db/migration-0003.int-spec.ts`
-- holds that file to the builder's output, and `db:check-policies` asserts ENABLE+FORCE
-- over every table either way. An index changes what the planner does, never what a
-- policy admits. Every statement below is the generator's, unchanged and in its order.
CREATE INDEX "invitation_workspaces_workspace_id_idx" ON "invitation_workspaces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invitations_invited_by_user_id_idx" ON "invitations" USING btree ("invited_by_user_id");--> statement-breakpoint
CREATE INDEX "invitations_accepted_by_user_id_idx" ON "invitations" USING btree ("accepted_by_user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");