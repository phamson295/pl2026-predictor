// Server cục bộ: phục vụ giao diện và cho phép nút "Cập nhật" chạy update.mjs.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };
let running = null;

const runUpdate = () => running ??= new Promise((resolve) => {
  let out = "";
  const p = spawn(process.execPath, [join(DIR, "update.mjs")], { cwd: DIR });
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => { running = null; resolve({ ok: code === 0, log: out.trim() }); });
});

createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && path === "/update") {
    const r = await runUpdate();
    res.writeHead(r.ok ? 200 : 500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(r));
  }
  const file = path === "/" ? "index.html" : path.slice(1);
  if (!["index.html", "data.js"].includes(file)) { res.writeHead(404); return res.end("Not found"); }
  try {
    res.writeHead(200, { "Content-Type": TYPES[extname(file)], "Cache-Control": "no-store" });
    res.end(await readFile(join(DIR, file)));
  } catch { res.writeHead(404); res.end("Not found"); }
}).listen(PORT, () => console.log(`Mở http://localhost:${PORT}`));
