import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("bookmarks", "routes/bookmarks.tsx"),
  route("profile", "routes/profile-redirect.tsx"),
  route("settings", "routes/settings.tsx"),
  route("users/:handle", "routes/profile.tsx"),
] satisfies RouteConfig;
