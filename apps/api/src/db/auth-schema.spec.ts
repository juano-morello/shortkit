import { getSchema } from 'better-auth/db';
import { bearer, jwt } from 'better-auth/plugins';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { type PgColumn, PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as authSchema from './schema/auth';

/**
 * STORY-001 — TASK-002. The drift pin ADR-0043 requires.
 *
 * Contract: `docs/contracts/auth-schema.md` ("What the implementer must guarantee", 2).
 * ADR: adr-0043-better-auth-schema-is-hand-written-and-pinned.md, adr-0013.
 *
 * ============================================================================
 * IT DOES NOT LIVE BESIDE THE MODULE IT PINS, AND MOVING IT BACK BREAKS A COMMAND.
 * ============================================================================
 *
 * `db/schema/auth-schema.spec.ts` would be the obvious home. `drizzle.config.ts:16` globs
 * `./src/db/schema/*.ts` and drizzle-kit `require()`s every match through its CJS
 * transformer, so ANY `*.spec.ts` in that directory fails `pnpm db:generate` with
 * "Vitest cannot be imported in a CommonJS module using require()" — measured with a
 * throwaway probe spec, drizzle-kit 0.31.10. `pnpm db:migrate` is unaffected: it reads the
 * config but never evaluates the schema glob (also measured). So the one command this
 * breaks is the one that generates the migration TASK-002 exists to write.
 *
 * F-045, ruled 2026-08-13: move the spec rather than narrow the glob, because
 * `drizzle.config.ts` is owned by no card. `apps/api/vitest.config.ts:10` includes
 * `src/**\/*.spec.ts` regardless of directory, so this is still the unit tier and still
 * runs on `pnpm test`.
 *
 * This file carries no AC of its own. It is what makes `auth.ts` hand-written rather than
 * generated-and-forgotten: a CLI run is a one-time event, so a `better-auth` upgrade that
 * adds a column produces a checked-in schema one column short, and the failure surfaces as
 * a `BetterAuthError` from `checkMissingFields`
 * (`@better-auth/drizzle-adapter/dist/index.mjs:298`) on a request path only some requests
 * reach. Asserted here on every `pnpm test`, in CI's `quality` job, before the integration
 * job and long before a request path.
 *
 * Unit tier: `getSchema(options)` takes a plain options object, opens no connection and
 * constructs no `betterAuth` instance. No database, no network.
 *
 * `plugins` IS THE ONLY OPTION THAT CHANGES THE ANSWER — measured, ADR-0043: `getSchema({})`
 * and `getSchema({ emailAndPassword: { enabled: true } })` return identical table and field
 * sets, and `[jwt(), bearer()]` adds exactly one table, `jwks`. TASK-003 owes the other half
 * of the pin, `getSchema(auth.options)` against this same literal; between wave 1 and wave 2
 * the pin is one-sided and the plugin list is declared twice.
 *
 * ============================================================================
 * NAMES, NULLABILITY, UNIQUENESS AND REFERENCES. NOT SQL TYPES.
 * ============================================================================
 *
 * `getSchema` speaks `string`, `boolean` and `date`. The mapping onto `text`, `boolean` and
 * `timestamptz` is THIS repository's choice, fixed in `auth-schema.md` and asserted against
 * `information_schema` in the integration tier. Comparing types here would assert our own
 * mapping against a vocabulary that does not contain it.
 */

/** ADR-0043's literal. A sixth plugin here and in `auth.config.ts` disagree loudly. */
const betterAuthTables = getSchema({ plugins: [jwt(), bearer()] });

/**
 * Every Drizzle table `auth.ts` exports, keyed by its SQL name — the comparison ADR-0043
 * states ("`getSchema()` key, against the Drizzle table's SQL name"). Derived from the
 * module's exports rather than from `betterAuthSchema`, so a sixth table declared here and
 * left out of the model map is still compared.
 *
 * NO `(exported): exported is PgTable` ANNOTATION ON THE FILTER, DELIBERATELY. `is()` is
 * declared `value is InstanceType<T>` and TypeScript 5.5+ infers the predicate from it, so
 * the annotation is redundant; worse, it does not compile — `PgTable<TableConfig>` is not
 * assignable to the union of this module's exports, each of which is a
 * `PgTableWithColumns<{ name: "user" }>` with a literal `name`, and a type predicate's type
 * must be assignable to its parameter's type (TS2677). The runtime filter is the same
 * either way; only the annotation was wrong.
 */
const declaredTables = new Map<string, PgTable>(
  Object.values(authSchema)
    .filter((exported) => is(exported, PgTable))
    .map((table) => [getTableName(table), table]),
);

/** `getSchema` does not report `id`; every one of the five carries it (auth-schema.md). */
const NOT_REPORTED_BY_GET_SCHEMA = 'id';

function propertyNamesOf(table: PgTable): string[] {
  return Object.keys(getTableColumns(table)).sort();
}

/**
 * `undefined` when the table declares no such property — the case the three assertions
 * below turn into a mismatch against a `getSchema()` field, rather than into a crash.
 *
 * Typed as `PgColumn` rather than cast to a bag of `unknown`: `notNull`, `isUnique` and
 * `primary` are declared members of drizzle's `Column`, so a typo in one of the three
 * reads below is a typecheck error here instead of a silent `undefined` that only fails
 * when the field it is compared against happens to be `true`.
 */
function columnOf(table: PgTable, property: string): PgColumn | undefined {
  return getTableColumns(table)[property];
}

/** `<model>.<field>` for every field `getSchema()` reports, so a failure names both. */
function everyField(): { model: string; field: string }[] {
  return Object.entries(betterAuthTables).flatMap(([model, table]) =>
    Object.keys(table.fields).map((field) => ({ model, field })),
  );
}

function attributeOf(model: string, field: string): Record<string, unknown> {
  return (
    betterAuthTables[model] as unknown as {
      fields: Record<string, Record<string, unknown>>;
    }
  ).fields[field];
}

describe('apps/api/src/db/schema/auth.ts', () => {
  it('ADR-0043: it declares a table for every model getSchema() returns for [jwt(), bearer()]', () => {
    expect([...declaredTables.keys()].sort()).toEqual(Object.keys(betterAuthTables).sort());
  });

  it('ADR-0043: every table declares exactly the fields getSchema() names, plus id', () => {
    const expected: Record<string, string[]> = {};
    const actual: Record<string, string[]> = {};

    for (const [model, table] of Object.entries(betterAuthTables)) {
      expected[model] = [...Object.keys(table.fields), NOT_REPORTED_BY_GET_SCHEMA].sort();

      const declared = declaredTables.get(model);
      // The property name is what the adapter indexes by (`schema[fieldName]`), so a
      // snake_cased property is a runtime BetterAuthError and not a style question.
      actual[model] = declared === undefined ? ['no such table'] : propertyNamesOf(declared);
    }

    expect(actual).toEqual(expected);
  });

  it('ADR-0043: nullability matches field.required on every field', () => {
    const expected: Record<string, boolean> = {};
    const actual: Record<string, unknown> = {};

    for (const { model, field } of everyField()) {
      const key = `${model}.${field}`;

      expected[key] = attributeOf(model, field).required === true;

      const declared = declaredTables.get(model);
      actual[key] = declared === undefined ? 'no such table' : columnOf(declared, field)?.notNull;
    }

    expect(actual).toEqual(expected);
  });

  it('ADR-0043: uniqueness matches field.unique on every field', () => {
    const expected: Record<string, boolean> = {};
    const actual: Record<string, unknown> = {};

    for (const { model, field } of everyField()) {
      const key = `${model}.${field}`;

      expected[key] = attributeOf(model, field).unique === true;

      const declared = declaredTables.get(model);
      actual[key] = declared === undefined ? 'no such table' : columnOf(declared, field)?.isUnique;
    }

    // `user.email` and `session.token` are the only two, and both are load-bearing:
    // sign-in resolves an account by email and a session by token.
    expect(actual).toEqual(expected);
  });

  it('ADR-0043: every foreign key matches field.references, target and onDelete', () => {
    const expected: Record<string, string> = {};

    for (const { model, field } of everyField()) {
      const references = attributeOf(model, field).references as
        | { model: string; field: string; onDelete?: string }
        | undefined;

      if (references !== undefined) {
        expected[`${model}.${field}`] =
          `${references.model}.${references.field} on delete ${references.onDelete ?? 'no action'}`;
      }
    }

    const actual: Record<string, string> = {};

    for (const [model, table] of declaredTables) {
      for (const foreignKey of getTableConfig(table).foreignKeys) {
        const reference = foreignKey.reference();
        const property = Object.entries(getTableColumns(table)).find(
          ([, column]) => column.name === reference.columns[0]?.name,
        )?.[0];

        actual[`${model}.${property ?? 'unknown property'}`] =
          `${getTableName(reference.foreignTable)}.${reference.foreignColumns[0]?.name ?? '?'} ` +
          `on delete ${foreignKey.onDelete ?? 'no action'}`;
      }
    }

    // Both point at `user(id)` and both cascade (auth-schema.md invariant 4). A missing
    // cascade leaves orphaned sessions and accounts after a GDPR erase.
    expect(actual).toEqual(expected);
  });

  it('auth-schema.md: every table carries an application-supplied id primary key', () => {
    const actual: Record<string, unknown> = {};

    for (const [model, table] of declaredTables) {
      const id = columnOf(table, NOT_REPORTED_BY_GET_SCHEMA);

      actual[model] = { primary: id?.primary === true, notNull: id?.notNull === true };
    }

    expect(actual).toEqual(
      Object.fromEntries(
        Object.keys(betterAuthTables).map((model) => [model, { primary: true, notNull: true }]),
      ),
    );
  });

  it('auth-schema.md: betterAuthSchema maps every model name to the table with that SQL name', () => {
    // Not covered by the five assertions above, which compare tables to `getSchema()` and
    // never read this map. A typo in a KEY here surfaces as `BetterAuthError: The model
    // "<model>" was not found in the schema object` on whichever request path first touches
    // that model — a runtime failure on a credential path.
    const mapped = Object.fromEntries(
      Object.entries(authSchema.betterAuthSchema).map(([model, table]) => [
        model,
        getTableName(table),
      ]),
    );

    expect(mapped).toEqual(
      Object.fromEntries(Object.keys(betterAuthTables).map((model) => [model, model])),
    );
  });
});
