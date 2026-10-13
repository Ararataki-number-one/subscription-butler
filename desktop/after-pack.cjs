/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
module.exports = async context => {
  const output = path.resolve(context.appOutDir);
  const runtime = path.join(output, "resources/runtime");
  if (!runtime.startsWith(output + path.sep)) throw new Error("Invalid packaged runtime");
  const binding = path.join(runtime, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
  if (!fs.existsSync(binding)) throw new Error("Packaged SQLite binding is missing");
  const program = `
    const fs=require("node:fs"),path=require("node:path");
    const root=fs.realpathSync.native(process.argv[1]);
    const normalize=value=>process.platform==="win32"?value.toLowerCase():value;
    const modules=["better-sqlite3","bindings","file-uri-to-path","drizzle-orm/better-sqlite3","drizzle-orm/better-sqlite3/migrator","drizzle-orm/migrator"];
    const resolved=modules.map(name=>{
      const file=fs.realpathSync.native(require.resolve(name,{paths:[root]}));
      if(!normalize(file).startsWith(normalize(root+path.sep)))throw new Error("Runtime dependency escaped bundle: "+name);
      return path.relative(root,file);
    });
    const Database=require(path.join(root,"node_modules/better-sqlite3"));
    const db=new Database(":memory:"); const sqlite=db.prepare("select 1 as ok").get().ok; db.close();
    console.log(JSON.stringify({sqlite,resolved}));
  `;
  const result = JSON.parse(execFileSync(path.join(runtime, "node.exe"), ["-e", program, runtime],
    { cwd: runtime, encoding: "utf8", windowsHide: true }));
  if (result.sqlite !== 1 || result.resolved.length !== 6) throw new Error("Packaged native runtime failed validation");
};
