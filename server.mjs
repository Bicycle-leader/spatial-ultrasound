import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

const pages = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
  ["/audio-input.js", "audio-input.js"],
  ["/audio-modem.js", "audio-modem.js"],
  ["/places.js", "places.js"],
]);

const contentTypes = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};

async function servePage(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }

  const [pathname] = request.url.split("?", 1);
  const filename = pages.get(pathname);
  if (!filename) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const file = await readFile(new URL(filename, import.meta.url));
    const extension = filename.split(".").pop();
    response.writeHead(200, {
      "Content-Type": contentTypes[extension],
      "Content-Length": file.byteLength,
    });
    response.end(file);
  } catch (error) {
    console.error(`Could not serve ${filename}: ${error.message}`);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Could not load this page");
  }
}

async function start() {
  const { HOST = "127.0.0.1", PORT = "4173", TLS_CERT, TLS_KEY } = process.env;
  const port = Number(PORT);
  if (!/^\d+$/.test(PORT) || port > 65535) {
    throw new Error("PORT must be an integer from 0 to 65535");
  }
  if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) {
    throw new Error("Set both TLS_CERT and TLS_KEY to use HTTPS");
  }

  let server = createHttpServer(servePage);
  let protocol = "http";
  if (TLS_CERT && TLS_KEY) {
    const [cert, key] = await Promise.all([readFile(TLS_CERT), readFile(TLS_KEY)]);
    server = createHttpsServer({ cert, key }, servePage);
    protocol = "https";
  }

  server.on("error", (error) => {
    console.error(`Could not listen on ${HOST}:${port}: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, HOST, () => {
    const urlHost = HOST.includes(":") ? `[${HOST}]` : HOST;
    console.log(`Spatial Ultrasound is running at ${protocol}://${urlHost}:${server.address().port}`);
  });
}

start().catch((error) => {
  console.error(`Could not start Spatial Ultrasound: ${error.message}`);
  process.exitCode = 1;
});
