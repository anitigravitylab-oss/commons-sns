import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, createUser, resetData, type TestApp } from "../testing/d1";
import { expectRedirect, getRequest, loginCookie, routeArgs } from "../testing/requests";
import { loader } from "./profile-redirect";

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.dispose();
});

beforeEach(async () => {
  await resetData(app.env);
});

describe("profile redirect loader", () => {
  it("sends anonymous visitors to the login modal", async () => {
    const result = await loader(routeArgs(getRequest("http://test.local/profile"), app.env, { pattern: "/profile" }));
    expect(expectRedirect(result).location).toBe("/?auth=login");
  });

  it("sends logged-in users to their own profile", async () => {
    const user = await createUser(app.env, { handle: "redirected" });
    const cookie = await loginCookie(app.env, user.id);
    const result = await loader(
      routeArgs(getRequest("http://test.local/profile", { cookie }), app.env, { pattern: "/profile" }),
    );
    expect(expectRedirect(result).location).toBe("/users/redirected");
  });
});
