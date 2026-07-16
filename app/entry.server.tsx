import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { SESSION_COOKIE } from "./lib/auth.server";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  let shellRendered = false;
  const body = await renderToReadableStream(<ServerRouter context={routerContext} url={request.url} />, {
    onError(error: unknown) {
      responseStatusCode = 500;
      if (shellRendered) console.error(error);
    },
  });
  shellRendered = true;

  const userAgent = request.headers.get("user-agent");
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");
  responseHeaders.set("X-Frame-Options", "DENY");
  // Pages rendered for a logged-in visitor contain personal state; keep them
  // out of shared and back-forward caches.
  if (request.headers.get("Cookie")?.includes(`${SESSION_COOKIE}=`)) {
    responseHeaders.set("Cache-Control", "no-store");
  }

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
