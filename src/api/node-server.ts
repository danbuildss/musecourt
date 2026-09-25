import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { errorResponse } from "./http";
import { ApiError } from "./errors";
import type { MuseCourtApi } from "./app";

/**
 * Serves the fetch-style API over node:http. Bodies are capped while
 * streaming, before the handler sees them.
 */
export function createNodeServer(api: MuseCourtApi, options: { maxBodyBytes: number }): Server {
  return createServer(createNodeHandler(api, options));
}

export interface NodeHandlerOptions {
  maxBodyBytes: number;
  /** Rewrites the incoming URL before routing (e.g. to undo a platform rewrite). */
  rewriteUrl?: (url: string) => string;
}

/** A plain `(req, res)` handler, usable by node:http or serverless platforms such as Vercel. */
export function createNodeHandler(
  api: MuseCourtApi,
  options: NodeHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let response: Response;
    try {
      const body = await readBody(req, options.maxBodyBytes);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
        else if (value !== undefined) headers.set(key, value);
      }
      const path = options.rewriteUrl ? options.rewriteUrl(req.url ?? "/") : (req.url ?? "/");
      const request = new Request(`http://${req.headers.host ?? "localhost"}${path}`, {
        method: req.method,
        headers,
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
      });
      response = await api.fetch(request, { clientIp: req.socket.remoteAddress ?? "unknown" });
    } catch (error) {
      response = errorResponse(error);
      // After an oversized body, don't keep the connection (and its unread bytes) around.
      res.setHeader("connection", "close");
      res.on("finish", () => req.destroy());
    }
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.removeAllListeners("data");
        req.resume(); // discard the rest; the connection is closed after the 413
        reject(
          new ApiError("PAYLOAD_TOO_LARGE", `The request body exceeds ${maxBytes} bytes.`, { maxBytes }),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
