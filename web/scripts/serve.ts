/** A static file server for dist/: `deno task dev`, then open http://localhost:8000. */

const dist = new URL("../dist/", import.meta.url);
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

Deno.serve({ port: Number(Deno.args[0] ?? 8000) }, async (req) => {
  const name = new URL(req.url).pathname.replace(/^\/+/, "") || "index.html";
  if (name.includes("..")) return new Response("bad path", { status: 400 });
  try {
    const body = await Deno.readFile(new URL(name, dist));
    return new Response(body, {
      headers: { "content-type": TYPES[name.split(".").pop()!] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
});
