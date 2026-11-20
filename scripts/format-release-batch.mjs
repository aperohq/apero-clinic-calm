// Formats only the supplied lint-inventory group, after checking both source
// syntax and emitted JavaScript for semantic differences. No directory sweep.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import ts from "typescript";
import * as prettier from "prettier";
const [inventoryPath, group, evidenceDirectory] = process.argv.slice(2);
if (!inventoryPath || !group || !evidenceDirectory)
  throw new Error(
    "Usage: format-release-batch.mjs inventory.json app|edge|tests|tooling evidence-directory",
  );
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
const classify = (file) =>
  file.startsWith("supabase/")
    ? "edge"
    : file.startsWith("tests/")
      ? "tests"
      : file.startsWith("src/")
        ? "app"
        : "tooling";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function tree(source, file) {
  const script = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (
      node.parent &&
      node.parent.name === node &&
      (ts.isIdentifier(node) || ts.isStringLiteral(node))
    )
      return ["name", node.text];
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
      return ["JSX-checked-in-emitted-runtime"];
    if (
      ts.isArrayLiteralExpression(node) &&
      ts.isPropertyAssignment(node.parent) &&
      node.parent.name.getText() === "children"
    ) {
      const children = [];
      for (const element of node.elements) {
        const item = visit(element);
        const previous = children.at(-1);
        // Prettier can express a JSX space as a separate string child. React
        // renders adjacent text children identically; do not normalize other arrays.
        if (ts.isStringLiteralLike(element) && previous?.[0] === ts.SyntaxKind.StringLiteral)
          previous[1] += element.text;
        else children.push(item);
      }
      return [node.kind, undefined, undefined, children];
    }
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    if (ts.isParenthesizedTypeNode(node)) return visit(node.type);
    const children = [];
    ts.forEachChild(node, (child) => {
      if (child.kind !== ts.SyntaxKind.JsxText) children.push(visit(child));
    });
    const text =
      node.kind === ts.SyntaxKind.JsxText || ts.isSourceFile(node)
        ? undefined
        : "text" in node
          ? node.text
          : undefined;
    return [node.kind, text, node.isTypeOnly, children];
  }
  return JSON.stringify(visit(script));
}
function runtime(source, file) {
  return tree(
    ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        removeComments: true,
        verbatimModuleSyntax: true,
      },
    }).outputText,
    "emitted.js",
  );
}
const changes = [];
for (const entry of inventory.filter((entry) => entry.errors && classify(entry.file) === group)) {
  const before = await readFile(entry.file, "utf8");
  const after = await prettier.format(before, {
    ...(await prettier.resolveConfig(entry.file)),
    filepath: entry.file,
  });
  if (
    tree(before, entry.file) !== tree(after, entry.file) ||
    runtime(before, entry.file) !== runtime(after, entry.file)
  ) {
    throw new Error("Semantic review required before formatting: " + entry.file);
  }
  changes.push({
    file: entry.file,
    before,
    after,
    before_sha256: hash(before),
    after_sha256: hash(after),
    source_ast: hash(tree(before, entry.file)),
    runtime_ast: hash(runtime(before, entry.file)),
    formatting_errors: entry.errors,
  });
}
await mkdir(evidenceDirectory, { recursive: true });
for (const { file, after } of changes) await writeFile(file, after);
await writeFile(
  evidenceDirectory + "/" + group + ".json",
  JSON.stringify(
    changes.map(({ before, after, ...evidence }) => evidence),
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    group,
    files: changes.length,
    formatting_errors: changes.reduce((n, x) => n + x.formatting_errors, 0),
    source_and_runtime_equivalent: true,
  }),
);
