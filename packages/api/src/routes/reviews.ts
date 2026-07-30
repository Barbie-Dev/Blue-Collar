import { Router, type Request, type Response } from 'express'
import { authenticate, authorize } from '../middleware/auth.js'
import { handleError } from '../utils/handleError.js'
import {
  createReview,
  deleteReview,
  flagReview,
  getModerationQueue,
  moderateReview,
  listWorkerReviews,
} from '../services/review.service.js'

const router = Router({ mergeParams: true })

/**
 * GET /api/workers/:workerId/reviews
 * List all reviews for a worker with aggregate stats.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const workerId = req.params.workerId ?? req.params.id
    const result = await listWorkerReviews(workerId)
    return res.json({ ...result, status: 'success', code: 200 })
  } catch (err) {
    return handleError(res, err)
  }
})

/**
 * POST /api/workers/:workerId/reviews
 * Create a review for a worker. Requires authentication.
 */
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const workerId = req.params.workerId ?? req.params.id
    const rating = Number(req.body.rating)
    const body = String(req.body.body ?? req.body.comment ?? '').trim()
    const comment = req.body.comment ? String(req.body.comment).trim() : undefined

    const review = await createReview(workerId, req.user!.id, rating, body, comment)
    return res.status(201).json({ data: review, status: 'success', code: 201 })
  } catch (err) {
    return handleError(res, err)
  }
})

/**
 * DELETE /api/workers/:workerId/reviews/:id
 * Delete a review. Only the review owner may delete.
 */
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    await deleteReview(req.params.id, req.user!.id)
    return res.status(204).send()
  } catch (err) {
    return handleError(res, err)
  }
})

/**
 * PATCH /api/workers/:workerId/reviews/:id/flag
 * Flag a review for moderation.
 */
router.patch('/:id/flag', authenticate, async (req: Request, res: Response) => {
  try {
    const updated = await flagReview(req.params.id, req.body.reason)
    return res.json({ data: updated, status: 'success', code: 200 })
  } catch (err) {
    return handleError(res, err)
  }
})

/**
 * GET /api/workers/:workerId/reviews/moderation/queue
 * Admin: get pending/flagged reviews.
 */
router.get(
  '/moderation/queue',
  authenticate,
  authorize('admin'),
  async (_req: Request, res: Response) => {
    try {
      const reviews = await getModerationQueue()
      return res.json({ data: reviews, status: 'success', code: 200 })
    } catch (err) {
      return handleError(res, err)
    }
  },
)

/**
 * PATCH /api/workers/:workerId/reviews/:id/moderate
 * Admin: approve or reject a review.
 */
router.patch(
  '/:id/moderate',
  authenticate,
  authorize('admin'),
  async (req: Request, res: Response) => {
    try {
      const { action } = req.body
      const updated = await moderateReview(req.params.id, action)
      return res.json({ data: updated, status: 'success', code: 200 })
    } catch (err) {
      return handleError(res, err)
    }
  },
)

export default router
