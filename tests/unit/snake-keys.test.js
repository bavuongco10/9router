import { describe, it, expect } from "vitest";
import { toSnakeCase, snakeifyKeys } from "../../src/shared/utils/snakeKeys.js";

describe("toSnakeCase", () => {
  it("converts camelCase, PascalCase, kebab and passes through snake_case", () => {
    expect(toSnakeCase("refreshToken")).toBe("refresh_token");
    expect(toSnakeCase("RefreshToken")).toBe("refresh_token");
    expect(toSnakeCase("refresh_token")).toBe("refresh_token");
    expect(toSnakeCase("profileArn")).toBe("profile_arn");
    expect(toSnakeCase("access-token")).toBe("access_token");
  });
});

describe("snakeifyKeys", () => {
  it("normalizes all keys of a Kiro account export", () => {
    expect(snakeifyKeys({ RefreshToken: "r", accessToken: "a", clientId: "c" }))
      .toEqual({ refresh_token: "r", access_token: "a", client_id: "c" });
  });

  it("prefers an exact snake_case key over a camelCase variant", () => {
    expect(snakeifyKeys({ refreshToken: "camel", refresh_token: "snake" }))
      .toEqual({ refresh_token: "snake" });
    expect(snakeifyKeys({ refresh_token: "snake", refreshToken: "camel" }))
      .toEqual({ refresh_token: "snake" });
  });
});
