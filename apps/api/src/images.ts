// Text-to-image through the xkiro OpenAI-shaped images API — one lane, no provider table.
const GENERATIONS_URL = "https://api.xkiro.com/v1/images/generations";
// Live catalog at GET /v1/models?modality=image; there is no account default model.
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2.5";
const DEFAULT_IMAGE_SIZE = "1024x1024";
const REQUEST_TIMEOUT_MS = 120_000;
// ponytail: fixed job-poll budget (~30s), fine for sync-style responses; raise if a queued-job model lands.
const JOB_POLL_ATTEMPTS = 12;
const JOB_POLL_DELAY_MS = 2500;

export class ImageGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export type ImageGenerationInput = {
  prompt: string;
  model?: string | undefined;
  size?: string | undefined;
};

export function buildImageGenerationRequest(
  input: ImageGenerationInput,
  opts: { apiKey: string; url?: string },
) {
  return {
    url: opts.url ?? GENERATIONS_URL,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
        // xkiro answers 403 to requests without a User-Agent.
        "user-agent": "rakazo",
      },
      body: JSON.stringify({
        model: input.model ?? DEFAULT_IMAGE_MODEL,
        prompt: input.prompt,
        n: 1,
        size: input.size ?? DEFAULT_IMAGE_SIZE,
      }),
    },
  };
}

export type ParsedImageGeneration = {
  url: string | null;
  base64: string | null;
  jobId: string | null;
};

/** Maps the response shapes: immediate image data, or a job id to poll. */
export function parseImageGenerationResponse(body: unknown): ParsedImageGeneration {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const first = Array.isArray(record.data) ? record.data[0] : undefined;
  const item = (typeof first === "object" && first !== null ? first : {}) as Record<
    string,
    unknown
  >;
  const url = typeof item.url === "string" ? item.url : null;
  const base64 = typeof item.b64_json === "string" ? item.b64_json : null;
  const jobId = url || base64 ? null : typeof record.id === "string" ? record.id : null;
  return { url, base64, jobId };
}

/** The generated image stored under a name derived from the prompt. */
export function imageNameForPrompt(prompt: string) {
  const slug = prompt.trim().slice(0, 60).replace(/\s+/g, " ");
  return `${slug || "generated image"}.png`;
}

async function fetchJson(url: string, init: RequestInit, apiKey: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${apiKey}`, "user-agent": "rakazo" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ImageGenerationError(`Image API unreachable: ${(error as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ImageGenerationError(`Image API error ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ImageGenerationError("Image API returned invalid JSON");
  }
}

/** One generation roundtrip: POST /v1/images/generations (+ job poll) and download the bytes. */
export async function generateImage(
  input: ImageGenerationInput,
  opts: { apiKey: string },
): Promise<Uint8Array> {
  const request = buildImageGenerationRequest(input, opts);
  let parsed = parseImageGenerationResponse(
    await fetchJson(request.url, request.init, opts.apiKey),
  );
  for (let attempt = 0; parsed.jobId && attempt < JOB_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_DELAY_MS));
    parsed = parseImageGenerationResponse(
      await fetchJson(`${request.url}/${parsed.jobId}`, { method: "GET" }, opts.apiKey),
    );
  }
  if (parsed.base64) return new Uint8Array(Buffer.from(parsed.base64, "base64"));
  if (parsed.url) {
    const response = await fetch(parsed.url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new ImageGenerationError(`Image download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  throw new ImageGenerationError("Image API returned no image and no finished job");
}
