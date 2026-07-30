-- AlterTable: Add transaction verification to Review
ALTER TABLE "Review" ADD COLUMN "transactionHash" TEXT,
ADD COLUMN "isVerified" BOOLEAN NOT NULL DEFAULT false;

-- Create index for verified reviews
CREATE INDEX "Review_workerId_isVerified_idx" ON "Review"("workerId", "isVerified");
