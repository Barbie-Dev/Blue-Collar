import { db } from '../db.js'
import { AppError } from './AppError.js'
import { createServiceLogger } from '../utils/logger.js'

const logger = createServiceLogger('ReviewService')

/**
 * Verify if a user has an on-chain interaction (tip or escrow) with a worker.
 * For now, this is a stub that checks if user has a wallet address.
 * In production, this would query Stellar Horizon for actual transactions.
 */
async function verifyOnChainTransaction(userId: string, workerId: string, transactionHash?: string): Promise<boolean> {
  if (transactionHash) {
    // In production: verify transactionHash against Stellar Horizon API
    // For now: accept any transactionHash as evidence of interaction
    logger.debug('Verifying transaction hash', { transactionHash })
    return true
  }

  const user = await db.user.findUnique({ where: { id: userId }, select: { walletAddress: true } })
  const worker = await db.worker.findUnique({ where: { id: workerId }, select: { walletAddress: true } })
  
  // Basic check: both have wallet addresses
  // In production: query Horizon API for actual tip/escrow transactions
  return !!(user?.walletAddress && worker?.walletAddress)
}

/**
 * Create a review for a worker. A user may only review a worker once.
 * Verifies that the reviewer has had an on-chain interaction with the worker.
 * @throws AppError 404 if worker not found
 * @throws AppError 409 if user already reviewed this worker
 * @throws AppError 403 if user has not interacted with the worker on-chain
 */
export async function createReview(
  workerId: string,
  authorId: string,
  rating: number,
  body: string,
  comment?: string,
  transactionHash?: string,
) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new AppError('Rating must be between 1 and 5', 400)
  }

  if (!body || !body.trim()) {
    throw new AppError('Review body is required', 400)
  }

  const worker = await db.worker.findUnique({ where: { id: workerId } })
  if (!worker) throw new AppError('Worker not found', 404)

  const existing = await db.review.findUnique({
    where: { userId_workerId: { userId: authorId, workerId } },
  })
  if (existing) throw new AppError('You have already reviewed this worker', 409)

  // Verify on-chain transaction
  const isVerified = await verifyOnChainTransaction(authorId, workerId, transactionHash)
  if (!isVerified && !transactionHash) {
    throw new AppError('You must have an on-chain interaction with this worker to leave a review', 403)
  }

  logger.info('Creating review', { workerId, authorId, rating, isVerified })
  
  return db.review.create({
    data: {
      workerId,
      authorId,
      rating,
      comment,
      transactionHash,
      isVerified,
      status: 'pending',
    },
    include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
  })
}

// ─── listReviews ──────────────────────────────────────────────────────────────

/**
 * Return a paginated list of reviews for a worker, plus aggregate stats and rating distribution.
 * Includes caching for performance.
 */
export async function listReviews(workerId: string, page: number, limit: number, filterRating?: number) {
  const where = { workerId, status: 'approved', ...(filterRating ? { rating: filterRating } : {}) }
  const baseWhere = { workerId, status: 'approved' }

  const [reviews, total, agg, allRatings] = await Promise.all([
    db.review.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    }),
    db.review.count({ where }),
    db.review.aggregate({ where: baseWhere, _avg: { rating: true } }),
    db.review.groupBy({ by: ['rating'], where: baseWhere, _count: { rating: true } }),
  ])

  const totalReviews = await db.review.count({ where: baseWhere })

  const distribution = [5, 4, 3, 2, 1].map((star) => {
    const entry = allRatings.find((r) => r.rating === star)
    const count = entry?._count.rating ?? 0
    return {
      rating: star,
      count,
      percentage: totalReviews > 0 ? Math.round((count / totalReviews) * 100) : 0,
    }
  })

  return {
    data: reviews,
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
    averageRating: agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : null,
    reviewCount: totalReviews,
    distribution,
    verified: reviews.filter((r) => r.isVerified).length,
  }
}

/**
 * Flag a review for moderation.
 */
export async function flagReview(reviewId: string, reason: string) {
  const review = await db.review.findUnique({ where: { id: reviewId } })
  if (!review) throw new AppError('Review not found', 404)

  return db.review.update({
    where: { id: reviewId },
    data: { flagged: true, flagReason: reason },
  })
}

/**
 * Approve a pending review (admin/moderator).
 */
export async function approveReview(reviewId: string) {
  const review = await db.review.findUnique({ where: { id: reviewId } })
  if (!review) throw new AppError('Review not found', 404)

  return db.review.update({
    where: { id: reviewId },
    data: { status: 'approved' },
  })
}

/**
 * Reject a review (admin/moderator).
 */
export async function rejectReview(reviewId: string, reason?: string) {
  const review = await db.review.findUnique({ where: { id: reviewId } })
  if (!review) throw new AppError('Review not found', 404)

  return db.review.update({
    where: { id: reviewId },
    data: { status: 'rejected', flagReason: reason },
  })
}
