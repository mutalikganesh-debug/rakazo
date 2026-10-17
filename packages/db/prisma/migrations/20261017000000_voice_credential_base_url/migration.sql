-- Voice: optional OpenAI-compatible API base URL override (null keeps the provider default).
ALTER TABLE "user_voice_credentials" ADD COLUMN "baseUrl" TEXT;
