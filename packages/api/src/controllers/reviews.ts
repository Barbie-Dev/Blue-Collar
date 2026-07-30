import type { Request, Response } from 'express'
import { handleError } from '../utils/handleError.js'
import {
  flagReview as flagReviewService,
  getModerationQueue as getModerationQueueService,
  moderateReview as moderateReviewService,
} from '../services/review.service.js'

/**
 * PATCH /api/workers/:workerId/reviews/:id/flag
 * Flag a review for admin moderation.
 */
export async function flagReview(req: Request, res: Response) {
  try {
    const updated = await flagReviewService(req.params.id, req.body.reason)
    return res.json({ data: updated, status: 'success', code: 200 })
  } catch (err) {
    return handleError(res, err)
  }
}

/**
 * GET /api/workers/:workerId/reviews/moderation/queue
 * Admin: return all pending or flagged reviews.
 */
export async function getModerationQueue(req: Request, res: Response) {
  try {
    const reviews = await getModerationQueueService()
    return res.json({ data: reviews, status: 'success', code: 200 })
  } catch (err) {
    return handleError(res, err)
  }
}

/**
 * PATCH /api/workers/:workerId/reviews/:id/moderate
 * Admin: approve or reject a review.
 * Body: { action: 'approve' | 'reject' }
 */
export async function moderateReview(req: Request, res: Response) {
  try {
    const { action } = req.body
    const updated = await moderateReviewService(req.params.id, action)
    return res.json({ data: updated, status: 'success', code: 200 })
  } catch (err) {
    return handleError(res, err)
  }
}
