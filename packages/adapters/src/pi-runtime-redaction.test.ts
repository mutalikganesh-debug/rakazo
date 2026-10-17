import type { TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { redactTranscriptContext } from "./pi-runtime.js";

const named = [{ name: "SUPER_KEY", value: "zz-top-secret-value" }];

function contextWith(...messages: unknown[]): TranscriptContext {
  return { messages } as unknown as TranscriptContext;
}

function firstBlock(message: unknown): Record<string, unknown> {
  return (message as { content: Array<Record<string, unknown>> }).content[0]!;
}

describe("redactTranscriptContext leak-guard", () => {
  it("scrubs text but leaves textSignature untouched (signed blocks survive)", () => {
    const out = redactTranscriptContext(
      contextWith({
        role: "user",
        content: [
          {
            type: "text",
            text: "key zz-top-secret-value",
            textSignature: "sig_sk-AbCdEfGhIjKlMn_opaque",
          },
        ],
        timestamp: 0,
      }),
      named,
    );
    const block = firstBlock(out.messages[0]);
    expect(block.text).toBe("key [REDACTED:SUPER_KEY]");
    expect(block.textSignature).toBe("sig_sk-AbCdEfGhIjKlMn_opaque");
  });

  it("scrubs thinking but leaves thinkingSignature untouched", () => {
    const out = redactTranscriptContext(
      contextWith({
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "recalled zz-top-secret-value",
            thinkingSignature: "sk-ThInKsIgNaTuRe0123456",
            redacted: false,
          },
        ],
        timestamp: 0,
      }),
      named,
    );
    const block = firstBlock(out.messages[0]);
    expect(block.thinking).toBe("recalled [REDACTED:SUPER_KEY]");
    expect(block.thinkingSignature).toBe("sk-ThInKsIgNaTuRe0123456");
    expect(block.redacted).toBe(false);
  });

  it("scrubs toolCall arguments (incl. JSON-embedded values) but never id/thoughtSignature", () => {
    const out = redactTranscriptContext(
      contextWith({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "sk-IdShApEd0123456789",
            name: "search",
            arguments: {
              query: "find zz-top-secret-value",
              payload: '{"token":"zz-top-secret-value"}',
            },
            thoughtSignature: "eyJhbGciOi.sig_sk-SiGnEd_0123456789.rest",
          },
        ],
        timestamp: 0,
      }),
      named,
    );
    const block = firstBlock(out.messages[0]);
    expect(block.id).toBe("sk-IdShApEd0123456789");
    expect(block.thoughtSignature).toBe("eyJhbGciOi.sig_sk-SiGnEd_0123456789.rest");
    const args = block.arguments as { query: string; payload: string };
    expect(args.query).toBe("find [REDACTED:SUPER_KEY]");
    expect(args.payload).not.toContain("zz-top-secret-value");
    expect(args.payload).toContain("[REDACTED:");
  });

  it("leaves image payloads untouched", () => {
    const image = {
      type: "image",
      data: "zz-top-secret-value+sk-AbCdEfGhIjKlMn",
      mimeType: "image/png",
    };
    const out = redactTranscriptContext(
      contextWith({ role: "user", content: [image], timestamp: 0 }),
      named,
    );
    expect(firstBlock(out.messages[0])).toEqual(image);
  });

  it("scrubs system content and sections, keeping nulls and non-string values intact", () => {
    const out = redactTranscriptContext(
      contextWith({
        role: "system",
        content: "system zz-top-secret-value",
        sections: {
          rules: "use zz-top-secret-value",
          removed: null,
          malformed: 42,
        },
        timestamp: 0,
      }),
      named,
    );
    const message = out.messages[0] as unknown as {
      content: string;
      sections: Record<string, unknown>;
    };
    expect(message.content).toBe("system [REDACTED:SUPER_KEY]");
    expect(message.sections.rules).toBe("use [REDACTED:SUPER_KEY]");
    expect(message.sections.removed).toBeNull();
    expect(message.sections.malformed).toBe(42);
  });

  it("scrubs tool-result content and details, and assistant error text", () => {
    const out = redactTranscriptContext(
      contextWith(
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "search",
          content: [{ type: "text", text: "out zz-top-secret-value" }],
          details: { raw: "detail zz-top-secret-value" },
          isError: false,
          timestamp: 0,
        },
        {
          role: "assistant",
          content: [],
          errorMessage: "provider echoed zz-top-secret-value",
          timestamp: 0,
        },
      ),
      named,
    );
    const toolResult = out.messages[0] as unknown as {
      content: Array<Record<string, unknown>>;
      details: { raw: string };
    };
    expect(firstBlock(toolResult).text).toBe("out [REDACTED:SUPER_KEY]");
    expect(toolResult.details.raw).toBe("detail [REDACTED:SUPER_KEY]");
    const assistant = out.messages[1] as unknown as { errorMessage: string };
    expect(assistant.errorMessage).toBe("provider echoed [REDACTED:SUPER_KEY]");
  });

  it("keeps unknown block types opaque instead of pattern-scrubbing their fields", () => {
    const out = redactTranscriptContext(
      contextWith({
        role: "user",
        content: [
          { type: "custom", id: "sk-CuStOmId0123456789", text: "plain zz-top-secret-value" },
        ],
        timestamp: 0,
      }),
      named,
    );
    const block = firstBlock(out.messages[0]);
    expect(block.id).toBe("sk-CuStOmId0123456789");
    expect(block.text).toBe("plain [REDACTED:SUPER_KEY]");
  });
});
