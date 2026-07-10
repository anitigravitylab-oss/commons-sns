import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext } from "../app/cloudflare";
import type { AppEnv } from "../app/cloudflare";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export type SocialEvent = {
  type: "post.created" | "reaction.changed" | "media.uploaded";
  actorId: string;
  objectId: string;
  occurredAt: string;
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        runtime: "cloudflare-workers",
        database: "DB" in env ? "connected" : "not-configured",
      });
    }

    const routerContext = new RouterContextProvider();
    routerContext.set(cloudflareContext, { env: env as AppEnv, ctx });

    return requestHandler(request, routerContext);
  },

  async queue(batch) {
    for (const message of batch.messages) {
      console.log("social event", message.body.type, message.body.objectId);
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, SocialEvent>;
