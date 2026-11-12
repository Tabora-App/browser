// Помечает русские надписи в коде тегом t`…`, чтобы их можно было перевести.
//   node tools/i18n/wrap.mjs [--write] [--import=<путь к i18n.js от корня>] <файлы…>
// Без --write только показывает, что изменится. Что делает:
//   "Надпись"            → t`Надпись`
//   `Письмо от ${name}`  → t`Письмо от ${name}`
//   plural(n, "письмо", "письма", "писем") → plural(n, t`письмо|письма|писем`)
// и добавляет в файл импорт t. Не трогает и показывает списком для ручного разбора:
//   сравнения и поиск по тексту (=== "…", includes("…")), ключи объектов, склейки через «+».
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parse } from "acorn";
import { fullAncestor } from "acorn-walk";

const args = process.argv.slice(2);
const write = args.includes("--write");
const importArg = (args.find(a => a.startsWith("--import=")) || "").slice(9);
const files = args.filter(a => !a.startsWith("--"));
const CYR = /[А-Яа-яЁё]/;
const TEXT_CALLS = new Set(["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "test", "match", "matchAll", "replace", "replaceAll", "split", "localeCompare", "querySelector", "querySelectorAll", "closest", "matches", "getAttribute", "setAttribute", "hasAttribute", "getItem", "setItem", "removeItem", "addEventListener", "removeEventListener"]);
const esc = s => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

let total = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module", ranges: true });
  const edits = []; // { start, end, text }
  const notes = [];
  const line = pos => src.slice(0, pos).split("\n").length;
  const done = new Set();
  const hasCyr = node => (node.type === "Literal" ? typeof node.value === "string" && CYR.test(node.value) : node.type === "TemplateLiteral" && node.quasis.some(q => CYR.test(q.value.cooked ?? "")));

  fullAncestor(ast, (node, _state, ancestors) => {
    if (done.has(node)) {
      return;
    }
    const parent = ancestors[ancestors.length - 2];
    // plural(n, "а", "б", "в") → одна надпись с формами через |
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "plural" && node.arguments.length === 4 && node.arguments.slice(1).every(a => a.type === "Literal" && typeof a.value === "string")) {
      const forms = node.arguments.slice(1);
      forms.forEach(f => done.add(f));
      edits.push({ start: forms[0].start, end: forms[2].end, text: "t`" + forms.map(f => esc(f.value)).join("|") + "`" });
      return;
    }
    if (!hasCyr(node)) {
      return;
    }
    const where = `${file}:${line(node.start)}`;
    const text = src.slice(node.start, node.end).slice(0, 90);
    if (parent.type === "TaggedTemplateExpression" && parent.quasi === node) {
      return; // уже помечено
    }
    if (parent.type === "ImportDeclaration" || parent.type === "ExportNamedDeclaration" || parent.type === "ExportAllDeclaration" || parent.type === "ImportExpression") {
      return;
    }
    if ((parent.type === "Property" || parent.type === "PropertyDefinition" || parent.type === "MethodDefinition") && parent.key === node && !parent.computed) {
      notes.push(`ключ объекта      ${where}  ${text}`);
      return;
    }
    if (parent.type === "MemberExpression" && parent.property === node) {
      notes.push(`обращение по ключу ${where}  ${text}`);
      return;
    }
    if (parent.type === "BinaryExpression" && ["===", "!==", "==", "!="].includes(parent.operator)) {
      notes.push(`сравнение         ${where}  ${text}`);
      return;
    }
    if (parent.type === "SwitchCase" && parent.test === node) {
      notes.push(`case              ${where}  ${text}`);
      return;
    }
    if (parent.type === "BinaryExpression" && parent.operator === "+") {
      notes.push(`склейка через +   ${where}  ${text}`);
      // помечается как есть: кусок переведётся отдельно; лучше переписать шаблоном вручную
    }
    if ((parent.type === "CallExpression" || parent.type === "NewExpression") && parent.arguments.includes(node)) {
      const c = parent.callee;
      const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" && c.property.type === "Identifier" ? c.property.name : "";
      const obj = c.type === "MemberExpression" && c.object.type === "Identifier" ? c.object.name : "";
      if (name === "RegExp" || obj === "console") {
        return;
      }
      if (TEXT_CALLS.has(name)) {
        notes.push(`поиск по тексту   ${where}  .${name}(${text})`);
        return;
      }
    }
    if (node.type === "Literal") {
      edits.push({ start: node.start, end: node.end, text: "t`" + esc(node.value) + "`" });
    } else {
      edits.push({ start: node.start, end: node.start, text: "t" });
    }
  });

  // местная переменная или параметр с именем t перекрыли бы тег перевода: такие надо переименовать
  const declared = pattern => {
    if (!pattern) {
      return [];
    }
    switch (pattern.type) {
      case "Identifier":
        return [pattern];
      case "ObjectPattern":
        return pattern.properties.flatMap(p => declared(p.type === "RestElement" ? p.argument : p.value));
      case "ArrayPattern":
        return pattern.elements.flatMap(declared);
      case "AssignmentPattern":
        return declared(pattern.left);
      case "RestElement":
        return declared(pattern.argument);
      default:
        return [];
    }
  };
  fullAncestor(ast, node => {
    const ids = node.type === "VariableDeclarator" ? declared(node.id) : /Function/.test(node.type) ? node.params.flatMap(declared) : node.type === "CatchClause" ? declared(node.param) : [];
    for (const id of ids) {
      if (id.name === "t") {
        notes.push(`ПЕРЕКРЫТ тег t     ${file}:${line(id.start)}  переименуйте местную переменную t`);
      }
    }
  });

  if (!edits.length && !notes.length) {
    continue;
  }
  let out = src;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  const needsImport = edits.length && !/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["'][^"']*i18n(\.sys)?\.m?js["']/.test(out);
  if (needsImport && importArg) {
    let rel = relative(dirname(resolve(file)), resolve(importArg)).split("\\").join("/");
    if (!rel.startsWith(".")) {
      rel = "./" + rel;
    }
    const stmt = `import { t } from "${rel}";\n`;
    const lastImport = [...out.matchAll(/^import[^\n]*\n/gm)].pop();
    out = lastImport ? out.slice(0, lastImport.index + lastImport[0].length) + stmt + out.slice(lastImport.index + lastImport[0].length) : stmt + out;
  }
  total += edits.length;
  console.log(`${file}: помечено ${edits.length}${notes.length ? `, на ручной разбор ${notes.length}` : ""}`);
  notes.forEach(n => console.log("   " + n));
  if (write && out !== src) {
    parse(out, { ecmaVersion: "latest", sourceType: "module" }); // результат обязан разбираться
    writeFileSync(file, out);
  }
}
console.log(`всего помечено: ${total}${write ? "" : " (пробный прогон, файлы не изменены)"}`);
