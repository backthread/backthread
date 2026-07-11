// Pulumi infra-extraction, pure parsing layer.
//
// Two entry points:
//   extractPulumiResources(sourceText, file) — ts-morph AST walk over a
//     TypeScript program file; finds NewExpression call sites for Pulumi SDK
//     classes (e.g. `new aws.lambda.Function('name', {...})`).
//   parsePulumiProject(yamlText) — YAML parse of Pulumi.yaml for the project
//     name + runtime.
//
// Deliberately pure: no file I/O, no global state. The ts-morph Project is
// created with an in-memory filesystem per call so every test is isolated.
//
// TS-only note: Python/Go Pulumi programs require a separate AST walk
// (py-ast / go/parser) — deferred to Phase-5 multilingual work. When
// `runtime` in Pulumi.yaml is not `nodejs` / `typescript` / `typescript-v8`
// the calling code skips source extraction but does not crash.

import { Project, SyntaxKind, type NewExpression, type Node as MorphNode } from 'ts-morph';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Types

export interface PulumiResource {
  /** Variable name the `new` expression is assigned to (if any). */
  varName?: string;
  /**
   * Dotted class path as written in source: `aws.lambda.Function`,
   * `gcp.cloudrun.Service`, `azure.storage.Account`, etc.
   */
  resourceType: string;
  /**
   * Adapter-local node id: `resource:<resourceType>.<logicalName>`.
   * Logical name = first string-literal argument to the constructor.
   */
  refAddr: string;
  /**
   * Identifiers that appear as the object of a PropertyAccessExpression inside
   * the constructor arguments (excluding the first logical-name arg).
   * E.g. `bucket.bucket` → `bucket`; `queue.url` → `queue`.
   *
   * Using AST-level identifier extraction (not regex over raw text) prevents
   * false matches from identifier substrings inside string literals
   * (e.g. `topic` inside `{ name: 'topic-handler' }` is NOT extracted).
   *
   * This replaces the earlier `argsText` string field.
   */
  referencedIdentifiers: string[];
  /**
   * raw text of the constructor args AFTER the first (logical-name)
   * arg — i.e. the props object. Used ONLY for deterministic source-signal
   * extraction (`image:`, `build.context`, `FileArchive(...)` paths), NEVER for
   * edges (edges use {@link referencedIdentifiers} so string-literal content
   * can't invent phantom edges). Empty string when there are no further args.
   */
  argsText: string;
}

export interface PulumiProject {
  name?: string;
  runtime?: string;
}

// ---------------------------------------------------------------------------
// Helpers

/** First segment of a dotted type path: `aws.lambda.Function` → `aws`. */
export function providerOf(resourceType: string): string {
  const dot = resourceType.indexOf('.');
  return dot > 0 ? resourceType.slice(0, dot) : resourceType.toLowerCase();
}

// ---------------------------------------------------------------------------
// YAML helper — Pulumi.yaml / Pulumi.<stack>.yaml

/**
 * Parse the minimal fields we care about from Pulumi.yaml.
 * Tolerates missing or malformed YAML: always returns an object.
 */
export function parsePulumiProject(yamlText: string): PulumiProject {
  try {
    const doc = parseYaml(yamlText);
    if (!doc || typeof doc !== 'object') return {};
    const obj = doc as Record<string, unknown>;
    const name = typeof obj['name'] === 'string' ? obj['name'] : undefined;
    // runtime may be a plain string ("nodejs") or a dict ({ name: "nodejs" })
    let runtime: string | undefined;
    if (typeof obj['runtime'] === 'string') {
      runtime = obj['runtime'];
    } else if (obj['runtime'] && typeof obj['runtime'] === 'object') {
      const rt = obj['runtime'] as Record<string, unknown>;
      if (typeof rt['name'] === 'string') runtime = rt['name'];
    }
    return { name, runtime };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// ts-morph extraction — TypeScript source files

/**
 * Walk a TypeScript source file (in-memory) and collect every
 * `new <Provider>.<Module>.<Class>(logicalName, args...)` call site.
 *
 * Matching criterion: the callee is a property-access chain (at least two
 * segments) — `aws.lambda.Function`, `gcp.cloudrun.Service`, etc. We do NOT
 * match single-segment constructors (e.g. `new MyClass(...)`) to avoid false
 * positives from user-defined classes.
 *
 * Tolerates unparseable or empty source: returns an empty array rather than
 * throwing (the calling layer also wraps in try/catch, but belt-and-suspenders
 * here so unit tests can verify the non-throw contract directly).
 */
export function extractPulumiResources(sourceText: string, file: string): PulumiResource[] {
  if (!sourceText || !sourceText.trim()) return [];

  let project: Project;
  try {
    project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(file, sourceText);
  } catch {
    return [];
  }

  const resources: PulumiResource[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const newExprs = sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression) as NewExpression[];
    let resourceIndex = 0;
    for (const expr of newExprs) {
      const callee = expr.getExpression();
      // Only match property-access chains (Provider.Module.Class or Provider.Class)
      if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;

      const resourceType = callee.getText();
      // Must have at least one dot (two segments)
      if (!resourceType.includes('.')) continue;

      // First arg: StringLiteral or NoSubstitutionTemplateLiteral give the Pulumi logical name.
      const args = expr.getArguments();
      if (args.length === 0) continue;
      const firstArg = args[0];
      const firstArgKind = firstArg.getKind();
      let logicalName: string;
      if (
        firstArgKind === SyntaxKind.StringLiteral ||
        firstArgKind === SyntaxKind.NoSubstitutionTemplateLiteral
      ) {
        // Strip surrounding quotes / backticks
        logicalName = firstArg.getText().replace(/^['"`]|['"`]$/g, '');
      } else {
        // Non-literal first arg (template expression, variable, etc.) — use the
        // resourceType's final segment + file + positional index as the logical
        // name so distinct call sites of the same type get distinct refAddrs.
        const lastDot = resourceType.lastIndexOf('.');
        const typeSuffix = resourceType.slice(lastDot + 1).toLowerCase();
        logicalName = `${typeSuffix}:${file}:${resourceIndex}`;
      }
      resourceIndex++;

      const refAddr = `${resourceType}.${logicalName}`;

      // Collect identifiers referenced as the *object* of PropertyAccessExpressions
      // inside the constructor arguments (first arg excluded — it's the logical name).
      // Walking AST nodes ensures string-literal content (e.g. `'topic-handler'`)
      // is never scanned, eliminating phantom edges from name-substring matches.
      const referencedIdentifiers: string[] = [];
      const remainingArgs = args.slice(1);
      for (const argNode of remainingArgs) {
        for (const propAccess of argNode.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
          const obj = propAccess.getExpression();
          if (obj.getKind() === SyntaxKind.Identifier) {
            referencedIdentifiers.push(obj.getText());
          }
        }
        // Also capture bare Identifier references that are not part of a PropertyAccess
        // (e.g. spreading a resource object: `...bucket`)
        for (const ident of argNode.getDescendantsOfKind(SyntaxKind.Identifier)) {
          const identParent = ident.getParent();
          // Only add if not already covered by the PropertyAccessExpression walk
          // (i.e., not the object of a property access, and not the property name)
          if (!identParent || identParent.getKind() !== SyntaxKind.PropertyAccessExpression) {
            referencedIdentifiers.push(ident.getText());
          }
        }
      }

      // varName: check if this NewExpression is the init of a VariableDeclaration
      let varName: string | undefined;
      const parent = expr.getParent();
      if (parent && parent.getKind() === SyntaxKind.VariableDeclaration) {
        const nameNode = (parent as MorphNode & { getName(): string }).getName?.();
        if (nameNode) varName = nameNode;
      }

      // raw props-args text for source-signal extraction (not edges).
      const argsText = remainingArgs.map((a) => a.getText()).join(' ');

      resources.push({ varName, resourceType, refAddr, referencedIdentifiers, argsText });
    }
  }

  return resources;
}
