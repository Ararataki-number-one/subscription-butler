export function parseCsv(source: string): string[][] {
  const text = source.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (character === '"') { quoted = false; closed = true; }
      else cell += character;
    } else if (character === '"') {
      if (cell || closed) throw new Error("CSV 引号位置无效。");
      quoted = true;
    } else if (character === ",") { row.push(cell); cell = ""; closed = false; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); if (row.some(value => value !== "")) rows.push(row);
      row = []; cell = ""; closed = false;
    } else {
      if (closed) throw new Error("CSV 引号之后只能是分隔符。");
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV 引号未闭合。");
  row.push(cell); if (row.some(value => value !== "")) rows.push(row);
  if (rows.length > 5001) throw new Error("一次最多导入 5000 行。");
  return rows;
}

export function writeCsv(rows: unknown[][]): string {
  return "\uFEFF" + rows.map(row => row.map(value => {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }).join(",")).join("\r\n");
}

export type CsvPreview = { rows: Record<string,string>[]; errors: {line:number;message:string}[]; duplicates:number };
export function previewCsv(source: string, required: string[]): CsvPreview {
  const parsed = parseCsv(source);
  const headers = parsed.shift()?.map(value => value.trim()) ?? [];
  if (!headers.length || new Set(headers).size !== headers.length) throw new Error("CSV 列名为空或重复。");
  for (const name of required) if (!headers.includes(name)) throw new Error("缺少列：" + name);
  const rows: Record<string,string>[] = [], errors: CsvPreview["errors"] = [], seen = new Set<string>();
  let duplicates = 0;
  parsed.forEach((cells,index) => {
    if (cells.length !== headers.length) { errors.push({line:index + 2,message:"列数与标题不一致。"}); return; }
    const row = Object.fromEntries(headers.map((name,i) => [name,cells[i].trim()]));
    const missing = required.filter(name => !row[name]);
    if (missing.length) { errors.push({line:index + 2,message:"未填写 " + missing.join("、")}); return; }
    const fingerprint = JSON.stringify(row);
    if (seen.has(fingerprint)) { duplicates++; return; }
    seen.add(fingerprint); rows.push(row);
  });
  return {rows,errors,duplicates};
}
