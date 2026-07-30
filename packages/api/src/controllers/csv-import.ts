import type { Request, Response } from 'express'
import { importWorkersFromCsv } from '../services/csv-import.service.js'
import { handleError } from '../utils/handleError.js'
import { getErrorMessage } from '../utils/getErrorMessage.js'

/**
 * POST /api/admin/workers/import
 * Upload a CSV file to bulk-import workers. Admin only.
 *
 * Expects multipart/form-data with a `file` field (text/csv).
 * Returns an import summary with counts and per-row errors.
 */
export async function importWorkersFromCsvController(req: Request, res: Response) {
  try {
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'CSV file is required', code: 400 })
    }

    const csvText = req.file.buffer.toString('utf-8')
    const result = await importWorkersFromCsv(csvText, req.user!.id)

    return res.status(result.imported > 0 ? 201 : 400).json({
      data: result,
      status: result.imported > 0 ? 'success' : 'error',
      message: `Imported ${result.imported} worker(s). ${result.failed} row(s) failed.`,
      code: result.imported > 0 ? 201 : 400,
    })
  } catch (err) {
    const message = getErrorMessage(err)
    if (message.startsWith('Missing required CSV column')) {
      return res.status(400).json({ status: 'error', message, code: 400 })
    }
    return handleError(res, err)
  }
}
