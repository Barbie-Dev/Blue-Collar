import type { Request, Response } from 'express'
import { handleError } from '../utils/handleError.js'
import { getWorkerReputation, syncReputationToDb } from '../services/stellar.service.js'

export async function getReputation(req: Request, res: Response) {
  try {
    const data = await getWorkerReputation(req.params.id)
    return res.json({ data, status: 'success', code: 200 })
  } catch (err) {
    return handleError(res, err)
  }
}

export async function syncReputation(req: Request, res: Response) {
  try {
    const { avgRating, reviewCount, reputation } = req.body as {
      avgRating: number
      reviewCount: number
      reputation: number
    }
    const data = await syncReputationToDb(req.params.id, avgRating, reviewCount, reputation)
    return res.json({ data, status: 'success', code: 200 })
  } catch (err) {
    return handleError(res, err)
  }
}
