type ParsedRow = { cells: string[]; line: number };

function parseCsvRows(source: string): ParsedRow[] {
  const text = source.replace(/^\uFEFF/, "");
  const rows: ParsedRow[] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  let line = 1, rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (character === '"') { quoted = false; closed = true; }
      else {
        cell += character;
        if (character === "\r" || character === "\n" && text[i - 1] !== "\r") line++;
      }
    } else if (character === '"') {
      if (cell || closed) throw new Error("CSV 引号位置无效。");
      quoted = true;
    } else if (character === ",") { row.push(cell); cell = ""; closed = false; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); if (row.some(value => value !== "")) rows.push({ cells: row, line: rowLine });
      row = []; cell = ""; closed = false;
      line++; rowLine = line;
    } else {
      if (closed) throw new Error("CSV 引号之后只能是分隔符。");
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV 引号未闭合。");
  row.push(cell); if (row.some(value => value !== "")) rows.push({ cells: row, line: rowLine });
  if (rows.length > 5001) throw new Error("一次最多导入 5000 行。");
  return rows;
}

export function parseCsv(source: string): string[][] {
  return parseCsvRows(source).map(row => row.cells);
}

export function writeCsv(rows: unknown[][]): string {
  return "\uFEFF" + rows.map(row => row.map(value => {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }).join(",")).join("\r\n");
}

export type CsvPreview = {
  rows: Record<string,string>[];
  /** Original physical start line for each accepted row, parallel to rows. */
  sourceLines: number[];
  errors: {line:number;message:string}[];
  duplicates:number;
};
export function previewCsv(source: string, required: string[]): CsvPreview {
  const parsed = parseCsvRows(source);
  const headers = parsed.shift()?.cells.map(value => value.trim()) ?? [];
  if (!headers.length || new Set(headers).size !== headers.length) throw new Error("CSV 列名为空或重复。");
  for (const name of required) if (!headers.includes(name)) throw new Error("缺少列：" + name);
  const rows: Record<string,string>[] = [], sourceLines: number[] = [], errors: CsvPreview["errors"] = [], seen = new Set<string>();
  let duplicates = 0;
  parsed.forEach(({ cells, line }) => {
    if (cells.length !== headers.length) { errors.push({line,message:"列数与标题不一致。"}); return; }
    const row = Object.fromEntries(headers.map((name,i) => [name,cells[i].trim()]));
    const missing = required.filter(name => !row[name]);
    if (missing.length) { errors.push({line,message:"未填写 " + missing.join("、")}); return; }
    const fingerprint = JSON.stringify(row);
    if (seen.has(fingerprint)) { duplicates++; return; }
    seen.add(fingerprint); rows.push(row); sourceLines.push(line);
  });
  return {rows,sourceLines,errors,duplicates};
}
