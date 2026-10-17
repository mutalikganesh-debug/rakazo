import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIVoiceProvider, openAiVoiceBase } from "./openai-voice.js";

const ctx = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openAiVoiceBase", () => {
  it("keeps the OpenAI default when no override is set", () => {
    expect(openAiVoiceBase(undefined)).toBe("https://api.openai.com/v1");
    expect(openAiVoiceBase("")).toBe("https://api.openai.com/v1");
    expect(openAiVoiceBase("   ")).toBe("https://api.openai.com/v1");
  });

  it("uses the override and drops trailing slashes", () => {
    expect(openAiVoiceBase("https://api.xkiro.com/v1")).toBe("https://api.xkiro.com/v1");
    expect(openAiVoiceBase(" https://api.xkiro.com/v1/// ")).toBe("https://api.xkiro.com/v1");
    expect(openAiVoiceBase("http://172.16.1.2:8643/v1")).toBe("http://172.16.1.2:8643/v1");
  });
});

describe("OpenAIVoiceProvider custom endpoint", () => {
  it("speaks against the configured server with the configured model", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const clip = await new OpenAIVoiceProvider().synthesize(
      {
        text: "hi",
        voiceId: "confident-male",
        apiKey: "test-key-123",
        model: "xkiro-voice",
        baseUrl: "https://api.xkiro.com/v1/",
      },
      ctx,
    );

    expect(Array.from(clip.bytes)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("https://api.xkiro.com/v1/audio/speech");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "xkiro-voice",
      voice: "confident-male",
      input: "hi",
    });
  });

  it("verifies the key against the configured server", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OpenAIVoiceProvider().verify("test-key-123", ctx, {
      baseUrl: "https://api.xkiro.com/v1",
    });

    expect(result.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.xkiro.com/v1/models");
  });
});
