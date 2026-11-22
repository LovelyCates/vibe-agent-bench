import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.mjs", ["app.mjs", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    if (url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ service: "frontend", ready: true }));
      return;
    }
    if (url.pathname === "/api/tasks") {
      const backend = await fetch(new URL(request.url, process.env.BACKEND_URL), {
        signal: AbortSignal.timeout(3000),
      });
      response.writeHead(backend.status, { "Content-Type": backend.headers.get("Content-Type") });
      response.end(Buffer.from(await backend.arrayBuffer()));
      return;
    }
    const asset = assets.get(url.pathname);
    if (asset) {
      const [file, contentType] = asset;
      const body = await readFile(new URL(file, import.meta.url));
      response.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8` });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(502);
    response.end();
  }
});

server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  console.log(JSON.stringify({ service: "frontend", port: server.address().port }));
});
