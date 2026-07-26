import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("bookmarks", "routes/bookmarks.tsx"),
  route("profile", "routes/profile-redirect.tsx"),
  route("settings", "routes/settings.tsx"),
  route("users/:handle", "routes/profile.tsx"),
  // フォロー一覧は1モジュールを2パスで使う。種別はモジュール側が URL の末尾で決める
  // （route.id はクライアント側の clientLoader からは読めないため）。
  // id を明示しないと同じファイルの2件目が重複エラーになる。
  route("users/:handle/following", "routes/follow-list.tsx", { id: "following" }),
  route("users/:handle/followers", "routes/follow-list.tsx", { id: "followers" }),
] satisfies RouteConfig;
