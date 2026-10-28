import type { Language } from "../language.ts";

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function charLength(text: string): number {
  return Array.from(text).length;
}

export interface NumberedLine {
  line: number;
  text: string;
}

export function isGeneratedPath(path: string): boolean {
  if (!path.startsWith("src/frontend/")) return false;
  return path.endsWith(".gql.ts") || path.includes("/app/api/") || path.includes("/app/generated/");
}

const STOP_WORDS = new Set(
  `about above after again against also among another anything because been before being below
between both could does doing down during each either else every from further have having here
into itself just more most much must only other over same should since some such than that their
theirs them themselves then there these they this those through under until upon very what when
where whether which while whose will with within without would your code file files logic
function functions method methods class classes implements implementation uses used using given
gets sets takes makes returns`.split(/\s+/),
);

export function findKeywords(description: string): string[] {
  const out: string[] = [];
  for (const word of description.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 4 && !STOP_WORDS.has(word) && !out.includes(word)) out.push(word);
  }
  return out;
}

const CS_M =
  "(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|virtual|override|async|extern|unsafe|new|const|volatile|required|file)";
const CS_T = "[\\w.<>\\[\\],?() ]+?";
const CS_A = "(?:\\[.*\\]\\s*)?";
const CS_TYPE = new RegExp(
  `^\\s*${CS_A}(?:${CS_M}\\s+)*(class|record|struct|interface|enum)\\s+(?:class\\s+|struct\\s+)?([A-Za-z_]\\w*)`,
);
const CS_CTOR = new RegExp(`^\\s*${CS_A}(?:${CS_M}\\s+)+([A-Za-z_]\\w*)\\s*\\(`);
const CS_METHOD = new RegExp(`^\\s*${CS_A}((?:${CS_M}\\s+)*)${CS_T}\\s+([A-Za-z_]\\w*)\\s*(?:<[^>]*>)?\\s*\\(`);
const CS_PROPERTY = new RegExp(
  `^\\s*${CS_A}(?:${CS_M}\\s+)*${CS_T}\\s+([A-Za-z_]\\w*)\\s*(?:\\{\\s*(?:get|set|init|private|protected|internal)|=>)`,
);
const CS_FIELD = new RegExp(`^\\s*${CS_A}(?:${CS_M}\\s+)+${CS_T}\\s+([A-Za-z_]\\w*)\\s*(?:=(?!>)|;|,)`);
const CS_NOT_METHOD_FIRST_WORDS = new Set(
  "return await throw new var yield else if for foreach while switch using lock catch case goto when in is as nameof typeof default".split(
    " ",
  ),
);

export interface Declaration {
  kind: string;
  name: string;
  line: number;
  column: number;
  recordParameter?: boolean;
}

function declaration(kind: string, name: string, line: NumberedLine, nameIndex: number): Declaration {
  return { kind, name, line: line.line, column: charLength(line.text.slice(0, nameIndex)) + 1 };
}

function groupIndex(text: string, match: RegExpExecArray, name: string): number {
  const end = match.index + match[0].length;
  const at = match[0].lastIndexOf(name);
  return at >= 0 ? match.index + at : end;
}

function csharpTypeDeclaration(line: NumberedLine): Declaration | null {
  const m = CS_TYPE.exec(line.text);
  return m === null ? null : declaration(m[1]!, m[2]!, line, groupIndex(line.text, m, m[2]!));
}

function csharpMemberDeclaration(line: NumberedLine, typeNames: ReadonlySet<string>): Declaration | null {
  const text = line.text;
  const ctor = CS_CTOR.exec(text);
  if (ctor !== null && typeNames.has(ctor[1]!)) return declaration("constructor", ctor[1]!, line, groupIndex(text, ctor, ctor[1]!));
  const method = CS_METHOD.exec(text);
  if (method !== null) {
    const name = method[2]!;
    const paren = method.index + method[0].length - 1;
    const firstWord = /^\s*(?:\[.*\]\s*)?([A-Za-z_]\w*)/.exec(text)?.[1] ?? "";
    const hasModifier = method[1]!.trim() !== "";
    if (
      !typeNames.has(name) &&
      !text.slice(0, paren).includes("=") &&
      !CS_NOT_METHOD_FIRST_WORDS.has(firstWord) &&
      (hasModifier || text.trimEnd().endsWith(");"))
    ) {
      return declaration("method", name, line, groupIndex(text, method, name));
    }
  }
  const property = CS_PROPERTY.exec(text);
  if (property !== null) return declaration("property", property[1]!, line, groupIndex(text, property, property[1]!));
  const field = CS_FIELD.exec(text);
  if (field !== null) {
    const before = text.slice(0, groupIndex(text, field, field[1]!));
    if (!/\b(event|delegate|using)\b/.test(before)) return declaration("field", field[1]!, line, groupIndex(text, field, field[1]!));
  }
  return null;
}

function recordParameters(lines: NumberedLine[], index: number, nameEnd: number): Declaration[] {
  const out: Declaration[] = [];
  let started = false;
  let depth = 0;
  let quote: string | null = null;
  let afterEquals = false;
  let last: Declaration | null = null;
  const flush = () => {
    if (last !== null) out.push(last);
    last = null;
    afterEquals = false;
  };
  for (let i = index; i < lines.length; i++) {
    const line = lines[i]!;
    const text = line.text;
    let c = i === index ? nameEnd : 0;
    quote = null;
    if (!started) {
      const rest = text.slice(c);
      const m = /^\s*(?:<[^>]*>)?\s*\(/.exec(rest);
      if (m === null) return out;
      c += m[0].length;
      started = true;
      depth = 1;
    }
    while (c < text.length) {
      const ch = text[c]!;
      if (quote !== null) {
        if (ch === "\\") c++;
        else if (ch === quote) quote = null;
        c++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        c++;
        continue;
      }
      if (ch === "/" && text[c + 1] === "/") break;
      if ("(<[{".includes(ch)) depth++;
      else if (")>]}".includes(ch)) {
        depth--;
        if (depth === 0) {
          flush();
          return out;
        }
      } else if (ch === "," && depth === 1) flush();
      else if (ch === "=" && depth === 1) afterEquals = true;
      else if (/[A-Za-z_]/.test(ch)) {
        const word = /^[A-Za-z_]\w*/.exec(text.slice(c))![0];
        if (!afterEquals) last = { ...declaration("property", word, line, c), recordParameter: true };
        c += word.length;
        continue;
      }
      c++;
    }
  }
  flush();
  return out;
}

function csharpOutline(lines: NumberedLine[]): Declaration[] {
  const typeNames = new Set<string>();
  for (const line of lines) {
    const t = csharpTypeDeclaration(line);
    if (t !== null) typeNames.add(t.name);
  }
  const out: Declaration[] = [];
  lines.forEach((line, i) => {
    const t = csharpTypeDeclaration(line);
    if (t !== null) {
      out.push(t);
      if (t.kind === "record") {
        const nameEnd = line.text.indexOf(t.name, CS_TYPE.exec(line.text)!.index) + t.name.length;
        out.push(...recordParameters(lines, i, nameEnd));
      }
      return;
    }
    const member = csharpMemberDeclaration(line, typeNames);
    if (member !== null) out.push(member);
  });
  return out;
}

const TS_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/;
const TS_CONST = /^(?:export\s+)?(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=(?!=)\s*(.*)$/;
const TS_CLASS = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const TS_INTERFACE = /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const TS_TYPE = /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<.*>)?\s*=/;
const TS_ENUM = /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const TS_METHOD =
  /^(\s+)(?:(?:public|private|protected|static|async|override|readonly|abstract|declare|get|set)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const TS_NOT_METHOD = new Set("if for while switch catch return constructor super function".split(" "));

function typescriptTopDeclaration(line: NumberedLine, tsx: boolean): Declaration | null {
  const text = line.text;
  let m = TS_FUNCTION.exec(text);
  if (m !== null) {
    const kind = tsx && /^[A-Z]/.test(m[1]!) ? "component" : "function";
    return declaration(kind, m[1]!, line, groupIndex(text, m, m[1]!));
  }
  m = TS_CONST.exec(text);
  if (m !== null) {
    const name = m[1]!;
    const value = m[2]!;
    const isFunction = /^(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(value);
    const wrapped = /^(?:memo\(|React\.memo\(|forwardRef\(|React\.forwardRef\()/.test(value);
    const kind = (isFunction && tsx && /^[A-Z]/.test(name)) || wrapped ? "component" : isFunction ? "function" : "constant";
    return declaration(kind, name, line, text.indexOf(name, text.indexOf("const") + 5));
  }
  for (const [kind, re] of [
    ["class", TS_CLASS],
    ["interface", TS_INTERFACE],
    ["type", TS_TYPE],
    ["enum", TS_ENUM],
  ] as const) {
    m = re.exec(text);
    if (m !== null) return declaration(kind, m[1]!, line, text.search(new RegExp(`(?<![\\w$])${escapeRegex(m[1]!)}(?![\\w$])`)));
  }
  return null;
}

function typescriptMethodDeclaration(line: NumberedLine, indent?: string): Declaration | null {
  const m = TS_METHOD.exec(line.text);
  if (m === null || TS_NOT_METHOD.has(m[2]!)) return null;
  if (indent !== undefined && m[1] !== indent) return null;
  return declaration("method", m[2]!, line, m.index + m[0].lastIndexOf(m[2]!));
}

function typescriptOutline(lines: NumberedLine[], tsx: boolean): Declaration[] {
  const out: Declaration[] = [];
  let inClass = false;
  let indent: string | null = null;
  for (const line of lines) {
    if (inClass) {
      if (line.text === "}") {
        inClass = false;
        continue;
      }
      if (indent === null) {
        const lead = /^(\s+)\S/.exec(line.text);
        if (lead !== null) indent = lead[1]!;
      }
      if (indent !== null) {
        const method = typescriptMethodDeclaration(line, indent);
        if (method !== null) out.push(method);
      }
      continue;
    }
    const top = typescriptTopDeclaration(line, tsx);
    if (top === null) continue;
    out.push(top);
    if (top.kind === "class" && !/\}\s*;?\s*$/.test(line.text)) {
      inClass = true;
      indent = null;
    }
  }
  return out;
}

const GQL_TYPE = /^(type|input|enum|interface)\s+([A-Za-z_]\w*)/;
const GQL_OPERATION = /^(query|mutation|subscription)\s+([A-Za-z_]\w*)/;
const GQL_FRAGMENT = /^fragment\s+([A-Za-z_]\w*)\s+on\s/;
const GQL_FIELD = /^\s+([A-Za-z_]\w*)\s*[:(]/;
const GQL_ENUM_VALUE = /^\s+([A-Za-z_]\w*)\s*(?:@.*)?$/;

function graphqlHeader(line: NumberedLine): Declaration | null {
  const text = line.text;
  let m = GQL_TYPE.exec(text);
  if (m !== null) {
    const kind = m[1] === "interface" ? "type" : m[1]!;
    return declaration(kind, m[2]!, line, text.indexOf(m[2]!, m[1]!.length));
  }
  m = GQL_OPERATION.exec(text);
  if (m !== null) return declaration(m[1]!, m[2]!, line, text.indexOf(m[2]!, m[1]!.length));
  m = GQL_FRAGMENT.exec(text);
  if (m !== null) return declaration("fragment", m[1]!, line, text.indexOf(m[1]!, 8));
  return null;
}

function graphqlMember(line: NumberedLine, blockKind: string | null): Declaration | null {
  if (blockKind === "type" || blockKind === "input") {
    const m = GQL_FIELD.exec(line.text);
    if (m !== null) return declaration("field", m[1]!, line, line.text.indexOf(m[1]!));
  }
  if (blockKind === "enum") {
    const m = GQL_ENUM_VALUE.exec(line.text);
    if (m !== null) return declaration("enum-value", m[1]!, line, line.text.indexOf(m[1]!));
  }
  return null;
}

function graphqlOutline(lines: NumberedLine[]): Declaration[] {
  const out: Declaration[] = [];
  let block: string | null = null;
  let inDescription = false;
  for (const line of lines) {
    const tripleQuotes = (line.text.match(/"""/g) ?? []).length;
    if (inDescription || tripleQuotes > 0) {
      if (tripleQuotes % 2 === 1) inDescription = !inDescription;
      continue;
    }
    const header = graphqlHeader(line);
    if (header !== null) {
      out.push(header);
      block = header.kind;
      continue;
    }
    const member = graphqlMember(line, block);
    if (member !== null) out.push(member);
  }
  return out;
}

export function outlineDeclarations(language: Language, path: string, lines: NumberedLine[]): Declaration[] {
  if (language === "csharp") return csharpOutline(lines);
  if (language === "typescript") return typescriptOutline(lines, path.endsWith(".tsx"));
  return graphqlOutline(lines);
}

export function blockEnd(lines: NumberedLine[], graphqlField: boolean): number | null {
  if (lines.length === 0) return null;
  if (graphqlField) {
    let parens = 0;
    for (const line of lines) {
      for (const ch of line.text) {
        if (ch === "(") parens++;
        else if (ch === ")") parens--;
      }
      if (parens <= 0) return line.line;
    }
    return null;
  }
  let depth = 0;
  let seen = false;
  for (const line of lines) {
    const text = line.text;
    let quote: string | null = null;
    for (let c = 0; c < text.length; c++) {
      const ch = text[c]!;
      if (quote !== null) {
        if (ch === "\\") c++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "/" && text[c + 1] === "/") break;
      else if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") {
        depth--;
        if (seen && depth === 0) return line.line;
      } else if (ch === ";" && depth === 0 && !seen) return line.line;
    }
  }
  return null;
}

export function camelCase(property: string): string {
  const run = /^[A-Z]+/.exec(property)?.[0] ?? "";
  if (run === "") return property;
  const rest = property.slice(run.length);
  if (run.length > 1 && /^[a-z]/.test(rest)) return run.slice(0, -1).toLowerCase() + run.slice(-1) + rest;
  return run.toLowerCase() + rest;
}
