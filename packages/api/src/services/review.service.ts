import { db } from '../db.js'
import { AppError } from './AppError.js'
import { sendModerationEmail } from '../mailer/index.js'

// ─── Spam detection ───────────────────────────────────────────────────────────

/**
 * Heuristic spam detector: repeated characters, ALL-CAPS, or known spam phrases.
 */
export function isSpam(text?: string): boolean {
  if (!text) return false
  if (text.length > 2000) return true
  if (/(.)\1{9,}/.test(text)) return true // 10+ repeated chars
  if (text === text.toUpperCase() && text.length > 20) return true // all caps
  const spamPhrases = ['buy now', 'click here', 'free money', 'make money fast']
  return spamPhrases.some((p) => text.toLowerCase().includes(p))
}

// ─── Service interface (for dependency injection) ─────────────────────────────

export interface ReviewService {
  createReview(
    workerId: string,
    authorId: string,
    rating: number,
    body: string,
    comment?: string,
  ): Promise<unknown>
  listReviews(
    workerId: string,
    page: number,
    limit: number,
    filterRating?: number,
  ): Promise<unknown>
  flagReview(reviewId: string, reason?: string): Promise<unknown>
  getModerationQueue(): Promise<unknown>
  moderateReview(reviewId: string, action: 'approve' | 'reject'): Promise<unknown>
  deleteReview(reviewId: string, requestingUserId: string): Promise<void>
}

// ─── createReview ─────────────────────────────────────────────────────────────

/**
 * Create a review for a worker. A user may only review a worker once.
 * @throws AppError 404 if worker not found
 * @throws AppError 409 if user already reviewed this worker
 */
export async function createReview(
  workerId: string,
  authorId: string,
  rating: number,
  body: string,
  comment?: string,
) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new AppError('Rating must be between 1 and 5', 400)
  }

  if (!body || !body.trim()) {
    throw new AppError('Review body is required', 400)
  }

  const worker = await db.worker.findUnique({ where: { id: workerId } })
  if (!worker) throw new AppError('Worker not found', 404)

  const spamFlagged = isSpam(body) || isSpam(comment)

  try {
    return await db.review.create({
      data: {
        workerId,
        userId: authorId,
        authorId,
        rating,
        body: body.trim(),
        comment: comment ?? body.trim(),
        flagged: spamFlagged,
        status: 'pending',
      },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new AppError('You have already reviewed this worker', 409)
    }
    throw err
  }
}

// ─── listReviews ──────────────────────────────────────────────────────────────

/**
 * Return a paginated list of approved reviews for a worker, plus aggregate stats.
 */
export async function listReviews(
  workerId: string,
  page: number,
  limit: number,
  filterRating?: number,
) {
  const where = {
    workerId,
    status: 'approved' as const,
    ...(filterRating ? { rating: filterRating } : {}),
  }
  const baseWhere = { workerId, status: 'approved' as const }

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
  }
}

// ─── listAllWorkerReviews (for the route handler — includes aggregate) ─────────

/**
 * Return all reviews for a worker (no pagination) with aggregate stats.
 * Used by the worker reviews route.
 */
export async function listWorkerReviews(workerId: string) {
  const [reviews, aggregate] = await Promise.all([
    db.review.findMany({
      where: { workerId },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.review.aggregate({
      where: { workerId },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ])

  return {
    data: reviews,
    avgRating: aggregate._avg.rating ?? 0,
    reviewCount: aggregate._count.rating,
  }
}

// ─── flagReview ───────────────────────────────────────────────────────────────

/**
 * Flag a review for moderation.
 * @throws AppError 404 if review not found
 */
export async function flagReview(reviewId: string, reason?: string) {
  const review = await db.review.findUnique({ where: { id: reviewId } })
  if (!review) throw new AppError('Review not found', 404)

  return db.review.update({
    where: { id: reviewId },
    data: { flagged: true, flagReason: reason ?? null, status: 'pending' },
  })
}

// ─── getModerationQueue ───────────────────────────────────────────────────────

/**
 * Return all reviews that are pending or flagged (admin moderation queue).
 */
export async function getModerationQueue() {
  return db.review.findMany({
    where: { OR: [{ status: 'pending' }, { flagged: true }] },
    include: {
      worker: { select: { id: true, name: true } },
      author: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
}

// ─── moderateReview ───────────────────────────────────────────────────────────

/**
 * Approve or reject a review and optionally notify the author.
 * @throws AppError 400 if action is invalid
 * @throws AppError 404 if review not found
 */
export async function moderateReview(reviewId: string, action: 'approve' | 'reject') {
  if (!['approve', 'reject'].includes(action)) {
    throw new AppError('action must be approve or reject', 400)
  }

  const review = await db.review.findUnique({
    where: { id: reviewId },
    include: { author: true },
  })
  if (!review) throw new AppError('Review not found', 404)

  const status = action === 'approve' ? 'approved' : 'rejected'
  const updated = await db.review.update({
    where: { id: reviewId },
    data: { status, flagged: false },
  })

  // Notify author — fire and forget, don't fail the request if email fails
  if (review.author?.email) {
    await sendModerationEmail(
      review.author.email,
      review.author.firstName,
      status,
    ).catch(() => {})
  }

  return updated
}

// ─── deleteReview ─────────────────────────────────────────────────────────────

/**
 * Delete a review. Only the review owner (userId) may delete it.
 * @throws AppError 404 if review not found
 * @throws AppError 403 if the requesting user does not own the review
 */
export async function deleteReview(reviewId: string, requestingUserId: string) {
  const review = await db.review.findUnique({ where: { id: reviewId } })
  if (!review) throw new AppError('Review not found', 404)

  // Support both userId and authorId ownership check
  const ownerId = review.userId ?? review.authorId
  if (ownerId !== requestingUserId) {
    throw new AppError('Forbidden', 403)
  }

  await db.review.delete({ where: { id: reviewId } })
}

// ─── Default service object (for dependency injection) ────────────────────────

export const reviewService: ReviewService = {
  createReview,
  listReviews,
  flagReview,
  getModerationQueue,
  moderateReview,
  deleteReview,
}

export default reviewService
