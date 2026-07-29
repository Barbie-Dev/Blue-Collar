/**
 * Payment controller — thin HTTP layer.
 * Parses request input, delegates to the contracts service, and formats responses.
 * All business logic and validation lives in contracts.service / payment.service.
 */
import type { Request, Response } from 'express'
import { catchAsync } from '../utils/catchAsync.js'
import * as contractsService from '../services/contracts.service.js'
import { HttpStatus } from '../constants/index.js'

/**
 * POST /api/payments/tip
 * Body: { from, to, amount }
 */
export const processTip = catchAsync(async (req: Request, res: Response) => {
  const { from, to, amount } = req.body
  const result = contractsService.processTip({ from, to, amount })
  return res.status(HttpStatus.OK).json({ data: result, status: 'success', code: HttpStatus.OK })
})

/**
 * POST /api/payments/escrow
 * Body: { from, to, amount, expiryDate }
 */
export const createEscrow = catchAsync(async (req: Request, res: Response) => {
  const { from, to, amount, expiryDate } = req.body
  const result = contractsService.createPaymentEscrow({ from, to, amount, expiryDate })
  return res.status(HttpStatus.CREATED).json({ data: result, status: 'success', code: HttpStatus.CREATED })
})

/**
 * GET /api/payments/fee
 */
export function getFee(_req: Request, res: Response) {
  return res.status(HttpStatus.OK).json({
    data: { fee_bps: contractsService.getPaymentFee() },
    status: 'success',
    code: HttpStatus.OK,
  })
}

/**
 * PATCH /api/payments/fee
 * Body: { fee_bps }
 * Requires admin role.
 */
export const updateFee = catchAsync(async (req: Request, res: Response) => {
  const { fee_bps } = req.body
  const updatedFee = contractsService.updatePaymentFee(req.user?.role ?? '', fee_bps)
  return res.status(HttpStatus.OK).json({
    data: { fee_bps: updatedFee },
    status: 'success',
    code: HttpStatus.OK,
  })
})
