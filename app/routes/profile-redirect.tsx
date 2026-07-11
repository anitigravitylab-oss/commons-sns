import { redirect } from "react-router";
import type { Route } from "./+types/profile-redirect";
import { cloudflareContext } from "../cloudflare";
import { getSessionUser } from "../lib/auth.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/");
  return redirect(`/users/${encodeURIComponent(user.handle)}`);
}

export default function ProfileRedirect() {
  return null;
}
