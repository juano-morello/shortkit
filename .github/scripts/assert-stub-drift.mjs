/**
 * `pnpm assert:stub-drift` (`node .github/scripts/assert-stub-drift.mjs`)
 *
 * The stub-versus-source gate. Closes the gap ADR-0039 admits it leaves open, for the
 * scope the foundation retro approved.
 *
 * WHAT WENT WRONG WITHOUT IT (F-288, a blocker). The design stub for
 * `apps/web/src/lib/api/client.ts` carried
 * `FORWARDED_REQUEST_HEADERS_MUTATING_ONLY = ['origin']` under a docblock titled "F-233.
 * Origin on mutating requests, and why dropping it breaks all of auth". The shipped file
 * did not. The predicted failure was every signup, sign-in and sign-out answering 403 in
 * production while every test passed, because the tests speak to the API directly and
 * never cross the proxy. A hand sweep found it. Nothing kept that sweep true, and the
 * absence was named four times across the initiative before this file existed.
 *
 * WHAT IS COMPARED, AND WHY IT IS NOT A TEXT DIFF. A stub's bodies throw
 * `not implemented`; its source has real ones. Comparing text produces a check nobody can
 * keep green, and a check nobody can keep green gets deleted — so the comparison is on
 * EXPORTED SHAPE, rebuilt from the parser rather than from the characters:
 *
 *   - Bodies are excluded. Function, method and accessor bodies never reach the
 *     comparison; only their signatures do.
 *   - Comments and whitespace are excluded, because the shape is collected as a token
 *     stream off the AST (`tokenText`) rather than as source text. Comment DRIFT is a real
 *     concern and ADR-0039 clause 4 covers it — as a human check at retirement, not here.
 *   - Declaration order is excluded: the two sides are compared as maps keyed on name.
 *   - Interface, class and object-type MEMBERS are sorted by their own rendering, and
 *     union and intersection constituents with them. None of those orders is semantic.
 *   - PARAMETER NAMES are excluded and positions kept. Stubs write `_jwt` for a parameter
 *     the throwing body cannot use and the source writes `jwt`; a check that called that
 *     drift would fire on every function in every materialised stub.
 *   - `async` is excluded. It is not visible in the type, and ADR-0039's own pre-deletion
 *     sweep found one of ten stubs "differing only by `async`" — a false positive this
 *     check would otherwise inherit on day one.
 *   - PRIVATE class members are excluded. They are not exported shape.
 *
 * ONE DIRECTION, AND THAT IS DELIBERATE (ADR-0039 clause 4). The rule checked is "every
 * exported declaration in the stub exists in the source, with the same shape". A
 * declaration the SOURCE has and the stub does not is reported and does not fail: a source
 * grows past its design-gate scaffold as later TASKs land, and failing on that would make
 * the check red for doing its job correctly. The failing direction is the F-288 direction —
 * something the design decided, missing from the code.
 *
 * HOW A STUB IS PAIRED WITH ITS SOURCE: BY PATH, NEVER BY THE HEADER. The workspace path
 * is the stub's path with `.sdlc/foundation/design/stubs/` removed. It is emphatically NOT
 * the TASK in the stub's `Produced by:` header — ADR-0039 clause 1 exists because those
 * differ in practice. `packages/contracts/src/domains/reserved-hostnames.ts` names TASK-038
 * in its header, which is deferred, and was materialised by TASK-007 in `09cb39a`. A
 * header-driven pairing reads that stub as unmaterialised and skips it.
 *
 * NO GIT SUBPROCESS, on purpose. ADR-0039 resolves the MATERIALISING TASK from git, and
 * this check does not need it: whether a source exists is a filesystem question, and the
 * commit that created it changes no verdict here. It also could not be answered honestly
 * in CI — `actions/checkout` clones at depth 1, so `git log --diff-filter=A` names the
 * shallow commit as the author of every file in the tree.
 *
 * A STUB WITH NO SOURCE IS NOT A FAILURE (ADR-0039 clause 2). Seventeen of the eighteen
 * surviving stubs name a deferred or unfinished producer. Their reason for existing still
 * holds, they have nothing to be stale against, and the run prints them as unmaterialised
 * rather than treating absence as drift.
 *
 * NOT TYPECHECKED: the root tsconfig's `include` is `["vitest.config.ts"]`, so nothing
 * under `.github/` is in any project's program. Plain ESM, Node runs it as written.
 * `typescript` is a root devDependency and resolves from the repository's `node_modules`.
 */
/* global process, console, URL */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const STUB_ROOT = path.join(ROOT, '.sdlc/foundation/design/stubs');

/**
 * ============================================================================
 * WHAT THIS GATE CAN FAIL ON, AND WHY IT IS NOT THE WHOLE TREE YET.
 * ============================================================================
 *
 * Workspace-path prefixes. A stub outside them is still parsed, still compared and still
 * REPORTED — it just cannot fail the build. The run prints which tier every pair landed
 * in, so nothing here is a silent exclusion.
 *
 * The foundation retro approved "a stub-versus-source gate for `apps/web`", and this is
 * that scope rather than a smaller reading of it. The whole tree is one constant away and
 * the difference today is EXACTLY ONE PAIR: `apps/api/src/observability/logger.ts`, which
 * is really drifted and is drifted on purpose. Its stub has been superseded since F-249,
 * `design/stubs/README.md` calls it "superseded and unsafe to copy", and ADR-0028 deleted
 * `REDACT_PATHS` from the running logger. TASK-003's close retires that stub (ADR-0039), at
 * which point there is no second copy and no exception to write.
 *
 * That is the trade, stated rather than buried: enforcing the whole tree today means
 * shipping an allowlist entry on day one for a divergence everyone already agreed to, and
 * ADR-0039's alternative 1 lost partly on exactly that cost. A scope carries the same
 * information with no per-file judgment to encode, and it expires the same way — WIDEN
 * THIS TO `['']` WHEN THE LOGGER STUB IS RETIRED. Nothing else in the tree has a source.
 */
const ENFORCED_PREFIXES = ['apps/web/'];

// ---------------------------------------------------------------------------
// Shape extraction
// ---------------------------------------------------------------------------

const isJsDoc = (node) =>
  node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

/**
 * A node rendered as its token stream, space-separated.
 *
 * The parser has already decided where strings, template literals and regex literals begin
 * and end, so taking leaf tokens off the AST is what makes comment stripping safe. A regex
 * over the text is not: `'https://example.test'` inside an initialiser loses its tail to a
 * `//` rule, and several stub constants carry URLs.
 *
 * `getText()` on a leaf starts at `getStart()`, which skips trivia — so comments never
 * enter the stream, wherever in the declaration they sit.
 */
function tokenText(node) {
  const out = [];

  const walk = (current) => {
    if (isJsDoc(current)) {
      return;
    }

    const children = current.getChildren().filter((child) => !isJsDoc(child));

    if (children.length === 0) {
      const text = current.getText();

      if (text !== '') {
        out.push(text);
      }

      return;
    }

    for (const child of children) {
      walk(child);
    }
  };

  walk(node);

  return out.join(' ');
}

const canon = (node) => (node === undefined ? null : tokenText(node));

/**
 * A type node, with the orders that are not semantic normalised away. Everything else
 * falls through to the token stream, which is exact.
 */
function canonType(type) {
  if (type === undefined) {
    return null;
  }

  if (ts.isParenthesizedTypeNode(type)) {
    return canonType(type.type);
  }

  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    const separator = ts.isUnionTypeNode(type) ? ' | ' : ' & ';

    return type.types.map(canonType).sort().join(separator);
  }

  if (ts.isTypeLiteralNode(type)) {
    return `{ ${memberShapes(type.members).join('; ')} }`;
  }

  return tokenText(type);
}

const hasModifier = (node, kind) => node.modifiers?.some((modifier) => modifier.kind === kind);

/**
 * `<T, U>(0: string, 1?: number) => R`.
 *
 * Positions rather than parameter names — see the docblock. A parameter's default value is
 * excluded for the same reason a body is: it is behaviour, not shape, and a stub whose body
 * throws has no reason to carry the real one.
 */
function signature(node) {
  const typeParameters =
    node.typeParameters === undefined || node.typeParameters.length === 0
      ? ''
      : `<${node.typeParameters.map(canon).join(', ')}>`;

  const parameters = node.parameters
    .map(
      (parameter, index) =>
        `${parameter.dotDotDotToken === undefined ? '' : '...'}${String(index)}` +
        `${parameter.questionToken === undefined ? '' : '?'}: ${canonType(parameter.type) ?? 'unknown'}`,
    )
    .join(', ');

  return `${typeParameters}(${parameters}) => ${canonType(node.type) ?? 'inferred'}`;
}

/**
 * One member of an interface, class or object type. Sorted by the caller, so the rendering
 * has to lead with the name for the ordering to read sensibly in a diff.
 */
function memberShape(member) {
  if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) {
    return null;
  }

  if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) {
    return null;
  }

  const name = member.name === undefined ? null : canon(member.name);
  const optional = member.questionToken === undefined ? '' : '?';
  const prefix = [
    hasModifier(member, ts.SyntaxKind.StaticKeyword) === true ? 'static ' : '',
    hasModifier(member, ts.SyntaxKind.ReadonlyKeyword) === true ? 'readonly ' : '',
  ].join('');

  if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
    return `${prefix}${name}${optional}: ${canonType(member.type) ?? 'inferred'}`;
  }

  if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
    return `${prefix}${name}${optional}${signature(member)}`;
  }

  if (ts.isGetAccessorDeclaration(member)) {
    return `${prefix}get ${name}: ${canonType(member.type) ?? 'inferred'}`;
  }

  if (ts.isSetAccessorDeclaration(member)) {
    return `${prefix}set ${name}${signature(member)}`;
  }

  if (ts.isConstructorDeclaration(member) || ts.isConstructSignatureDeclaration(member)) {
    return `new ${signature(member)}`;
  }

  if (ts.isCallSignatureDeclaration(member)) {
    return `() ${signature(member)}`;
  }

  if (ts.isIndexSignatureDeclaration(member)) {
    return `[index] ${signature(member)}`;
  }

  if (ts.isEnumMember(member)) {
    return `${name} = ${canon(member.initializer) ?? '<auto>'}`;
  }

  // Anything the list above does not name falls back to its exact tokens rather than
  // being dropped. A silently dropped member is a divergence this check cannot see.
  return tokenText(member);
}

const memberShapes = (members) =>
  members
    .map(memberShape)
    .filter((shape) => shape !== null)
    .sort();

function heritage(node) {
  if (node.heritageClauses === undefined) {
    return '';
  }

  return node.heritageClauses
    .map((clause) => {
      const keyword = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';

      return `${keyword} ${clause.types.map(canon).sort().join(', ')}`;
    })
    .sort()
    .join(' ');
}

/**
 * An initialiser contributes to shape, because a stub's constants carry REAL values — the
 * throwing body is a function's, not a constant's, and `FORWARDED_REQUEST_HEADERS_MUTATING_ONLY
 * = ['origin']` is the whole of F-288. A function-valued initialiser is the exception: its
 * body is a body wherever it is written, so only its signature is taken.
 */
function initialiserShape(initialiser) {
  if (initialiser === undefined) {
    return '';
  }

  if (ts.isArrowFunction(initialiser) || ts.isFunctionExpression(initialiser)) {
    return ` = ${signature(initialiser)}`;
  }

  if (ts.isClassExpression(initialiser)) {
    return ` = class ${heritage(initialiser)} { ${memberShapes(initialiser.members).join('; ')} }`;
  }

  return ` = ${tokenText(initialiser)}`;
}

/**
 * Every exported declaration in a file, as `name -> { kind, detail }`.
 *
 * A duplicate name — an overload set, or a declaration merged with an interface — is joined
 * rather than overwritten, so a source that drops one overload of two is still a difference.
 */
function exportedShape(filePath, source) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const shape = new Map();

  const add = (name, kind, detail) => {
    const existing = shape.get(name);

    shape.set(
      name,
      existing === undefined
        ? { kind, detail }
        : { kind: existing.kind, detail: `${existing.detail} && ${detail}` },
    );
  };

  for (const statement of sourceFile.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword) === true;

    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      // `export { a, b }`, `export * from './x'`, `export default …`. None of the eighteen
      // stubs uses one today; handled so that adding one cannot make this check blind.
      add(tokenText(statement), 're-export', '');
      continue;
    }

    if (!exported) {
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      add(canon(statement.name) ?? 'default', 'function', signature(statement));
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      add(
        canon(statement.name) ?? 'default',
        'class',
        `${heritage(statement)} { ${memberShapes(statement.members).join('; ')} }`,
      );
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      const typeParameters =
        statement.typeParameters === undefined || statement.typeParameters.length === 0
          ? ''
          : `<${statement.typeParameters.map(canon).join(', ')}>`;

      add(
        canon(statement.name),
        'interface',
        `${typeParameters} ${heritage(statement)} { ${memberShapes(statement.members).join('; ')} }`,
      );
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      const typeParameters =
        statement.typeParameters === undefined || statement.typeParameters.length === 0
          ? ''
          : `<${statement.typeParameters.map(canon).join(', ')}>`;

      add(canon(statement.name), 'type', `${typeParameters} = ${canonType(statement.type)}`);
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      add(canon(statement.name), 'enum', `{ ${memberShapes(statement.members).join('; ')} }`);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const keyword =
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
          ? 'const'
          : (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
            ? 'let'
            : 'var';

      for (const declaration of statement.declarationList.declarations) {
        add(
          canon(declaration.name),
          keyword,
          `${declaration.type === undefined ? '' : `: ${canonType(declaration.type)}`}` +
            initialiserShape(declaration.initializer),
        );
      }

      continue;
    }

    // Namespaces and anything a future TypeScript version adds. Exact tokens rather than a
    // skip, for the same reason `memberShape` has a fallback: an unrecognised export that
    // silently contributes nothing is an invisible divergence.
    add(
      canon(statement.name) ?? ts.SyntaxKind[statement.kind],
      ts.SyntaxKind[statement.kind],
      tokenText(statement),
    );
  }

  return shape;
}

// ---------------------------------------------------------------------------
// Comparison and reporting
// ---------------------------------------------------------------------------

/** Long initialisers are compared in full and printed short. */
function abbreviate(detail) {
  const limit = 180;

  return detail.length <= limit ? detail : `${detail.slice(0, limit)}… (${String(detail.length)} chars)`;
}

/**
 * Returns `{ failures, additions }`. `failures` is the ADR-0039 clause 4 direction — in the
 * stub, missing or different in the source. `additions` is the other direction, which is
 * reported and never fails.
 */
function compare(stubShape, sourceShape) {
  const failures = [];
  const additions = [];

  for (const [name, stubEntry] of stubShape) {
    const sourceEntry = sourceShape.get(name);

    if (sourceEntry === undefined) {
      failures.push(
        `MISSING FROM SOURCE: \`${stubEntry.kind} ${name}\` is exported by the stub and by ` +
          "nothing in the source — F-288's shape.",
      );
      continue;
    }

    if (sourceEntry.kind !== stubEntry.kind) {
      failures.push(
        `KIND CHANGED: \`${name}\` is a ${stubEntry.kind} in the stub and a ${sourceEntry.kind} ` +
          'in the source.',
      );
      continue;
    }

    if (sourceEntry.detail !== stubEntry.detail) {
      failures.push(
        `SHAPE CHANGED: \`${stubEntry.kind} ${name}\`\n` +
          `        stub:   ${abbreviate(stubEntry.detail)}\n` +
          `        source: ${abbreviate(sourceEntry.detail)}`,
      );
    }
  }

  for (const [name, sourceEntry] of sourceShape) {
    if (!stubShape.has(name)) {
      additions.push(`${sourceEntry.kind} ${name}`);
    }
  }

  return { failures, additions };
}

function findStubs(directory, prefix = '') {
  const found = [];

  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      found.push(...findStubs(path.join(directory, entry.name), relative));
      continue;
    }

    if (entry.isFile() && (relative.endsWith('.ts') || relative.endsWith('.tsx'))) {
      found.push(relative);
    }
  }

  return found;
}

// ---------------------------------------------------------------------------

if (!existsSync(STUB_ROOT)) {
  console.error(
    `FAIL: ${path.relative(ROOT, STUB_ROOT)} does not exist. This check cannot pass by finding ` +
      'nothing to check — a moved or renamed stub tree is a wiring defect, not a clean run. ' +
      'Retire this script if the tree is gone for good, do not let it go green over an empty path.',
  );
  process.exit(1);
}

const stubs = findStubs(STUB_ROOT);

if (stubs.length === 0) {
  console.error(
    `FAIL: no stubs found under ${path.relative(ROOT, STUB_ROOT)}. Same reasoning as the missing ` +
      'root above: a vacuous pass is the failure mode this whole check exists to prevent.',
  );
  process.exit(1);
}

const enforcedFailures = [];
const observedDrift = [];
let enforcedInScope = 0;
let enforcedCompared = 0;
let observedCompared = 0;
const unmaterialised = [];

for (const workspacePath of stubs) {
  const enforced = ENFORCED_PREFIXES.some((prefix) => workspacePath.startsWith(prefix));
  const tier = enforced ? 'ENFORCED' : 'observed';

  if (enforced) {
    enforcedInScope += 1;
  }

  const sourcePath = path.join(ROOT, workspacePath);

  if (!existsSync(sourcePath)) {
    unmaterialised.push(workspacePath);
    console.log(`--- ${workspacePath} [${tier}]`);
    console.log('    no source file yet — not drift (ADR-0039 clause 2).');
    continue;
  }

  const stubShape = exportedShape(
    workspacePath,
    readFileSync(path.join(STUB_ROOT, workspacePath), 'utf8'),
  );
  const sourceShape = exportedShape(workspacePath, readFileSync(sourcePath, 'utf8'));
  const { failures, additions } = compare(stubShape, sourceShape);

  if (enforced) {
    enforcedCompared += 1;
  } else {
    observedCompared += 1;
  }

  console.log(`--- ${workspacePath} [${tier}]`);
  console.log(
    `    ${String(stubShape.size)} exported declaration(s) in the stub, ` +
      `${String(sourceShape.size)} in the source.`,
  );

  for (const addition of additions) {
    console.log(`    only in the source (not drift, the source grows): ${addition}`);
  }

  if (failures.length === 0) {
    console.log('    OK: every declaration the stub exports exists in the source, same shape.');
    continue;
  }

  for (const failure of failures) {
    console.log(`    ${failure}`);
  }

  const collected = enforced ? enforcedFailures : observedDrift;

  collected.push(`${workspacePath}\n${failures.map((line) => `    - ${line}`).join('\n')}`);
}

console.log(
  `\nEnforced scope: ${ENFORCED_PREFIXES.map((prefix) => `${prefix}**`).join(', ')}. ` +
    `${String(enforcedInScope)} stub(s) in it, ${String(enforcedCompared)} with a source to ` +
    `compare against.\n` +
    `Outside it: ${String(stubs.length - enforcedInScope)} stub(s), ${String(observedCompared)} ` +
    'compared and reported without gating.\n' +
    `Unmaterialised: ${String(unmaterialised.length)} of ${String(stubs.length)}.`,
);

if (enforcedInScope > 0 && enforcedCompared === 0) {
  console.log(
    '\nNOTE: nothing in the enforced scope has a source file yet, so this run compared no ' +
      'gating pair. That is the correct verdict under ADR-0039 clause 2 and it is also a gate ' +
      'defending nothing today. It starts defending the moment the producing TASK lands the ' +
      'file — which is the window F-288 happened in.',
  );
}

if (observedDrift.length > 0) {
  console.log(
    `\nOBSERVED DRIFT, OUTSIDE THE ENFORCED SCOPE — ${String(observedDrift.length)} file(s). ` +
      'These do NOT fail this check and nothing here is being swallowed: they are outside ' +
      "`ENFORCED_PREFIXES`, which is a scope decision recorded above that file's constant, not " +
      'a per-run exception.\n\n' +
      observedDrift.map((entry) => `  ${entry}`).join('\n\n'),
  );
}

if (enforcedFailures.length > 0) {
  console.error(
    `\nFAIL: ${String(enforcedFailures.length)} stub(s) in the enforced scope disagree with their ` +
      'source on exported shape.\n\n' +
      enforcedFailures.map((entry) => `  ${entry}`).join('\n\n') +
      '\n\nDo not repair this by editing the stub to match. A declaration in the stub and ' +
      'missing from the source is a DIVERGENCE TO FILE (ADR-0039 clause 4) — decide which side ' +
      'is right, fix that side, and if the stub is the stale one because its TASK has closed, ' +
      'retire the stub instead of syncing it.',
  );
  process.exit(1);
}

console.log(
  enforcedCompared === 0
    ? '\nOK: no enforced pair had both a stub and a source, so there was no shape to disagree on.'
    : `\nOK: ${String(enforcedCompared)} enforced stub/source pair(s) agree on exported shape.`,
);
