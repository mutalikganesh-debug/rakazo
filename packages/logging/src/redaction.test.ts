import { describe, expect, it } from "vitest";
import { redactBindings, redactLeaks, redactSensitiveText } from "./redaction.js";

describe("redaction", () => {
  it("redacts secrets, credentials, and message bodies", () => {
    const redacted = redactBindings({
      "user.id": "user-1",
      email: "person@example.com",
      authorization: "Bearer secret",
      cookie: "session=abc",
      prompt: "do not log",
      messages: [{ role: "user", content: "hi" }],
      body: { text: "payload" },
      query: { q: "search" },
      apiKey: "sk-live",
      nested: { password: "hunter2", token: "abc", safe: true },
    });
    expect(redacted["user.id"]).toBe("user-1");
    expect(redacted.email).toBe("[Redacted]");
    expect(redacted.authorization).toBe("[Redacted]");
    expect(redacted.cookie).toBe("[Redacted]");
    expect(redacted.prompt).toBe("[Redacted]");
    expect(redacted.messages).toBe("[Redacted]");
    expect(redacted.body).toBe("[Redacted]");
    expect(redacted.query).toBe("[Redacted]");
    expect(redacted.apiKey).toBe("[Redacted]");
    expect(redacted.nested).toEqual({ password: "[Redacted]", token: "[Redacted]", safe: true });
  });

  it("replaces circular values", () => {
    const cycle: Record<string, unknown> = { "request.id": "r1" };
    cycle.self = cycle;
    const redacted = redactBindings(cycle);
    expect(redacted["request.id"]).toBe("r1");
    expect(redacted.self).toBe("[Circular]");
  });

  it("redacts Error values nested in bindings", () => {
    const cause = new Error("password=inner-secret");
    const error = new Error("request failed with token=outer-secret", { cause });

    const redacted = redactBindings({ detail: error });

    expect(redacted.detail).toMatchObject({
      name: "Error",
      message: "request failed with token=[Redacted]",
      cause: { name: "Error", message: "password=[Redacted]" },
    });
    expect(JSON.stringify(redacted.detail)).not.toMatch(/inner-secret|outer-secret/);
  });

  it("redacts string Error causes", () => {
    const error = new Error("request failed", { cause: "token=cause-secret" });

    const redacted = redactBindings({ detail: error });

    expect(redacted.detail).toMatchObject({
      name: "Error",
      message: "request failed",
      cause: "token=[Redacted]",
    });
    expect(JSON.stringify(redacted.detail)).not.toContain("cause-secret");
  });

  it("redacts secrets embedded in string binding values", () => {
    const redacted = redactBindings({
      detail: "token=binding-secret",
      nested: { note: "Bearer nested-secret" },
    });

    expect(redacted).toEqual({
      detail: "token=[Redacted]",
      nested: { note: "Bearer [Redacted]" },
    });
  });

  it("redacts secrets embedded in free text", () => {
    const redacted = redactSensitiveText(
      "user person@example.com used Bearer supersecret and token=abc123",
    );
    expect(redacted).toContain("[Redacted]");
    expect(redacted).not.toContain("person@example.com");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).not.toContain("abc123");
  });

  it("redacts bare API keys and JWTs in free text", () => {
    const redacted = redactSensitiveText(
      "key sk-or-v1-abc123456789 and sk-live-secret99 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig ak_secretvaluehere",
    );
    expect(redacted).not.toMatch(
      /sk-or-v1-abc123456789|sk-live-secret99|eyJhbGciOiJIUzI1NiJ9|ak_secretvaluehere/,
    );
    expect(redacted).toContain("[Redacted]");
  });

  it("redacts quoted JSON credential fields", () => {
    const redacted = redactSensitiveText(
      '{"password":"hunter2","token":"abc","authorization":"Bearer secret"}',
    );
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain('"token":"abc"');
    expect(redacted).not.toContain("Bearer secret");
    expect(redacted).toContain('"password":"[Redacted]"');
    expect(redacted).toContain('"token":"[Redacted]"');
    expect(redacted).toContain('"authorization":"[Redacted]"');
  });
});

describe("leak-guard redactLeaks", () => {
  it("masks named vault values with stable names and scrubs key patterns", () => {
    const text = [
      "vault value zz-top-secret-value here",
      "bare sk-or-v1-abcdefghijkl",
      "Authorization: Bearer ghs_abc123",
      'payload {"token":"json-secret-123456"} done',
      "OPENAI_API_KEY=env-secret-123456",
      "github token ghs_abc123 inline",
    ].join("\n");
    const out = redactLeaks(text, [{ name: "SUPER_KEY", value: "zz-top-secret-value" }]);
    expect(out).toBe(
      [
        "vault value [REDACTED:SUPER_KEY] here",
        "bare [REDACTED:api-key]",
        "Authorization=[REDACTED:authorization] [REDACTED:bearer]",
        'payload {"token":"[REDACTED:token]"} done',
        "OPENAI_API_KEY=[REDACTED:openai_api_key]",
        "github token [REDACTED:api-key] inline",
      ].join("\n"),
    );
  });

  it("masks longer named values first so overlapping values keep their own names", () => {
    const out = redactLeaks("a: 12345678 b: 1234567890", [
      { name: "SHORT", value: "12345678" },
      { name: "LONG", value: "1234567890" },
    ]);
    expect(out).toBe("a: [REDACTED:SHORT] b: [REDACTED:LONG]");
  });

  it("skips named values below the prose floor", () => {
    const out = redactLeaks("one wxyz1234 two abcd567", [
      { name: "SHORT", value: "abcd567" },
      { name: "LONG", value: "wxyz1234" },
    ]);
    expect(out).toBe("one [REDACTED:LONG] two abcd567");
  });
});
