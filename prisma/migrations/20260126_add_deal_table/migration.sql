-- CreateTable
CREATE TABLE "deal" (
    "id" SERIAL NOT NULL,
    "publicKey" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "creator" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "traderId" INTEGER NOT NULL,
    "traderAddress" TEXT NOT NULL,
    "rewardAmount" DECIMAL NOT NULL,
    "targetVolume" DECIMAL NOT NULL,
    "minBuyVolume" DECIMAL,
    "expirationHours" INTEGER NOT NULL,
    "holdDurationHours" INTEGER NOT NULL,
    "escrowVault" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isAccepted" BOOLEAN NOT NULL DEFAULT false,
    "volumeCompleted" DECIMAL,
    "outcome" TEXT,

    CONSTRAINT "deal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deal_publicKey_key" ON "deal"("publicKey");

-- CreateIndex
CREATE INDEX "deal_traderAddress_idx" ON "deal"("traderAddress");

-- CreateIndex
CREATE INDEX "deal_traderId_idx" ON "deal"("traderId");

-- CreateIndex
CREATE INDEX "deal_expiresAt_idx" ON "deal"("expiresAt");

-- CreateIndex
CREATE INDEX "deal_isActive_isAccepted_idx" ON "deal"("isActive", "isAccepted");

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_traderId_fkey" FOREIGN KEY ("traderId") REFERENCES "trader"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
