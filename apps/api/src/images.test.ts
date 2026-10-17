import { describe, expect, it } from "vitest";
import {
  buildImageGenerationRequest,
  imageNameForPrompt,
  parseImageGenerationResponse,
} from "./images.js";

describe("xkiro image generation mapping", () => {
  it("builds the request and maps every response shape", () => {
    const request = buildImageGenerationRequest(
      { prompt: "a red dot", model: "sensenova/sensenova-u1.5-lite", size: "512x512" },
      { apiKey: "test-key" },
    );
    expect(request.url).toBe("https://api.xkiro.com/v1/images/generations");
    expect(request.init.method).toBe("POST");
    const headers = request.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${"test-key"}`);
    expect(headers["user-agent"]).toBeTruthy();
    expect(JSON.parse(request.init.body as string)).toEqual({
      model: "sensenova/sensenova-u1.5-lite",
      prompt: "a red dot",
      n: 1,
      size: "512x512",
    });

    const defaults = JSON.parse(
      buildImageGenerationRequest({ prompt: "x" }, { apiKey: "k" }).init.body as string,
    );
    expect(defaults).toMatchObject({ model: "openai/gpt-image-2.5", size: "1024x1024", n: 1 });

    expect(parseImageGenerationResponse({ data: [{ url: "https://cdn/img.png" }] })).toEqual({
      url: "https://cdn/img.png",
      base64: null,
      jobId: null,
    });
    expect(parseImageGenerationResponse({ data: [{ b64_json: "aGk=" }] })).toEqual({
      url: null,
      base64: "aGk=",
      jobId: null,
    });
    expect(parseImageGenerationResponse({ id: "job-1", status: "queued" })).toEqual({
      url: null,
      base64: null,
      jobId: "job-1",
    });

    expect(imageNameForPrompt("  a red\ndot  ")).toBe("a red dot.png");
    expect(imageNameForPrompt("   ")).toBe("generated image.png");
  });
});
