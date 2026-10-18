-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "persona" TEXT NOT NULL,
    "modelProvider" TEXT,
    "modelId" TEXT,
    "color" TEXT NOT NULL DEFAULT '#9B5CF6',
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliberation_rooms" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "jointAnswer" TEXT,
    "dissent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliberation_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliberation_messages" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "agentId" TEXT,
    "agentName" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deliberation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_profiles_spaceId_userId_ordinal_idx" ON "agent_profiles"("spaceId", "userId", "ordinal");

-- CreateIndex
CREATE INDEX "deliberation_rooms_spaceId_userId_updatedAt_idx" ON "deliberation_rooms"("spaceId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "deliberation_messages_roomId_seq_idx" ON "deliberation_messages"("roomId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "deliberation_messages_roomId_seq_key" ON "deliberation_messages"("roomId", "seq");

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliberation_rooms" ADD CONSTRAINT "deliberation_rooms_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliberation_rooms" ADD CONSTRAINT "deliberation_rooms_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliberation_messages" ADD CONSTRAINT "deliberation_messages_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "deliberation_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliberation_messages" ADD CONSTRAINT "deliberation_messages_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
