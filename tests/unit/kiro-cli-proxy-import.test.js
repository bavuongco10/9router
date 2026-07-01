import { describe, it, expect } from "vitest";
import { normalizeKiroExternalIdpAuth } from "../../src/lib/oauth/kiroExternalIdp.js";

// CLIProxyAPI export with mixed / PascalCase keys should import the same as snake_case.
const pascal = {
  AuthMethod: "external_idp",
  AccessToken: "access-abc",
  RefreshToken: "refresh-xyz",
  ClientId: "client-123",
  TokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  ProfileArn: "arn:aws:codewhisperer:us-east-1:123:profile/X",
  Scopes: ["openid", "profile"],
  Email: "user@example.com",
};

describe("normalizeKiroExternalIdpAuth key casing", () => {
  it("accepts PascalCase keys", () => {
    const out = normalizeKiroExternalIdpAuth(pascal);
    expect(out.accessToken).toBe("access-abc");
    expect(out.refreshToken).toBe("refresh-xyz");
    expect(out.email).toBe("user@example.com");
    expect(out.providerSpecificData).toMatchObject({
      clientId: "client-123",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/X",
      tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scope: "openid profile",
    });
  });
});
