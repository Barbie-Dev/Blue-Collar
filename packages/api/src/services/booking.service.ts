/**
 * Booking service — Issue #776
 *
 * Handles booking request creation, conflict detection, timezone handling,
 * and notification dispatch on booking events.
 */

import { db } from '../db.js'
import { AppError } from '../utils/AppError.js'
import { logger } from '../config/logger.js'
import { enqueueNotification } from '../queue/index.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreateBookingInput {
  workerId: string
  requesterId: string
  /** ISO 8601 datetime — stored in UTC */
  startTime: string
  /** ISO 8601 datetime — stored in UTC */
  endTime: string
  timezone: string
  note?: string
  serviceDescription: string
}

export interface BookingSlot {
  startTime: Date
  endTime: Date
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert an ISO string to UTC Date, validating it is a real date. */
function parseUtc(iso: string, field: string): Date {
  const d = new Date(iso)
  if (isNaN(d.getTime())) throw new AppError(`${field} is not a valid ISO datetime`, 400)
  return d
}

/**
 * Detect if `newSlot` conflicts with any of `existingSlots`.
 * Two slots conflict when they overlap (start < other.end && end > other.start).
 */
function hasConflict(newSlot: BookingSlot, existingSlots: BookingSlot[]): boolean {
  return existingSlots.some(
    (s) => newSlot.startTime < s.endTime && newSlot.endTime > s.startTime,
  )
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Create a booking request after validating availability and conflicts.
 *
 * Checks:
 * 1. Start time is in the future
 * 2. End time is after start time
 * 3. Worker exists
 * 4. Requester is not the worker
 * 5. Slot falls within worker's availability schedule
 * 6. No existing confirmed/pending booking conflicts
 */
export async function createBooking(input: CreateBookingInput) {
  const { workerId, requesterId, timezone, note, serviceDescription } = input

  const startTime = parseUtc(input.startTime, 'startTime')
  const endTime = parseUtc(input.endTime, 'endTime')
  const now = new Date()

  if (startTime <= now) throw new AppError('startTime must be in the future', 400)
  if (endTime <= startTime) throw new AppError('endTime must be after startTime', 400)

  if (workerId === requesterId) throw new AppError('You cannot book yourself', 400)

  // Verify worker exists
  const worker = await db.worker.findUnique({ where: { id: workerId }, select: { id: true, userId: true } })
  if (!worker) throw new AppError('Worker not found', 404)

  // Check availability schedule — slot must fall within at least one available window
  const dayOfWeek = startTime.getUTCDay()
  const slotStartMinutes = startTime.getUTCHours() * 60 + startTime.getUTCMinutes()
  const slotEndMinutes = endTime.getUTCHours() * 60 + endTime.getUTCMinutes()

  const availability = await db.availability.findMany({ where: { workerId, dayOfWeek } })
  const coveredByAvailability = availability.some((avail) => {
    const [ah, am] = avail.startTime.split(':').map(Number)
    const [bh, bm] = avail.endTime.split(':').map(Number)
    return slotStartMinutes >= ah * 60 + am && slotEndMinutes <= bh * 60 + bm
  })

  if (availability.length > 0 && !coveredByAvailability) {
    throw new AppError('Requested time is outside the worker\'s availability', 409)
  }

  // Conflict check against existing bookings
  const existingBookings = await db.booking.findMany({
    where: {
      workerId,
      status: { in: ['pending', 'confirmed'] },
      OR: [
        { startTime: { lt: endTime }, endTime: { gt: startTime } },
      ],
    },
    select: { startTime: true, endTime: true },
  })

  if (hasConflict({ startTime, endTime }, existingBookings)) {
    throw new AppError('Worker is already booked during this time slot', 409)
  }

  // Create the booking
  const booking = await db.booking.create({
    data: {
      workerId,
      requesterId,
      startTime,
      endTime,
      timezone,
      note,
      serviceDescription,
      status: 'pending',
    },
    include: {
      worker: { select: { userId: true } },
      requester: { select: { id: true, firstName: true } },
    },
  })

  logger.info({ bookingId: booking.id, workerId, requesterId }, 'Booking request created')

  // Notify worker of new booking request
  await enqueueNotification({
    userId: booking.worker.userId,
    type: 'booking_request',
    title: 'New booking request',
    message: `${booking.requester.firstName ?? 'A user'} has requested a booking on ${startTime.toUTCString()}.`,
    channels: ['email', 'push', 'inapp'],
    href: `/bookings/${booking.id}`,
  })

  return booking
}

/**
 * Confirm a pending booking (worker only).
 */
export async function confirmBooking(bookingId: string, workerId: string) {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    include: { requester: { select: { id: true, firstName: true } } },
  })
  if (!booking) throw new AppError('Booking not found', 404)
  if (booking.workerId !== workerId) throw new AppError('Unauthorized', 403)
  if (booking.status !== 'pending') throw new AppError(`Cannot confirm a booking with status: ${booking.status}`, 400)

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { status: 'confirmed' },
  })

  await enqueueNotification({
    userId: booking.requesterId,
    type: 'booking_confirmed',
    title: 'Booking confirmed!',
    message: `Your booking on ${booking.startTime.toUTCString()} has been confirmed.`,
    channels: ['email', 'push', 'inapp'],
    href: `/bookings/${bookingId}`,
  })

  return updated
}

/**
 * Cancel a booking (either party can cancel; workers can cancel confirmed bookings).
 */
export async function cancelBooking(bookingId: string, userId: string, reason?: string) {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    include: {
      worker: { select: { userId: true } },
    },
  })
  if (!booking) throw new AppError('Booking not found', 404)

  const isRequester = booking.requesterId === userId
  const isWorker = booking.worker.userId === userId
  if (!isRequester && !isWorker) throw new AppError('Unauthorized', 403)

  if (['completed', 'cancelled'].includes(booking.status)) {
    throw new AppError(`Cannot cancel a booking with status: ${booking.status}`, 400)
  }

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { status: 'cancelled', cancellationReason: reason },
  })

  // Notify the other party
  const notifyUserId = isWorker ? booking.requesterId : booking.worker.userId
  await enqueueNotification({
    userId: notifyUserId,
    type: 'booking_cancelled',
    title: 'Booking cancelled',
    message: `A booking on ${booking.startTime.toUTCString()} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
    channels: ['email', 'inapp'],
  })

  return updated
}

/**
 * List all bookings for a worker (paginated).
 */
export async function getWorkerBookings(
  workerId: string,
  options: { page?: number; limit?: number; status?: string } = {},
) {
  const { page = 1, limit = 20, status } = options
  const skip = (page - 1) * limit

  const [bookings, total] = await Promise.all([
    db.booking.findMany({
      where: { workerId, ...(status ? { status } : {}) },
      orderBy: { startTime: 'asc' },
      skip,
      take: limit,
      include: { requester: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
    }),
    db.booking.count({ where: { workerId, ...(status ? { status } : {}) } }),
  ])

  return { bookings, total, page, limit, totalPages: Math.ceil(total / limit) }
}

/**
 * List all bookings made by a requester.
 */
export async function getRequesterBookings(
  requesterId: string,
  options: { page?: number; limit?: number; status?: string } = {},
) {
  const { page = 1, limit = 20, status } = options
  const skip = (page - 1) * limit

  const [bookings, total] = await Promise.all([
    db.booking.findMany({
      where: { requesterId, ...(status ? { status } : {}) },
      orderBy: { startTime: 'asc' },
      skip,
      take: limit,
      include: {
        worker: {
          select: { id: true, name: true, category: true },
        },
      },
    }),
    db.booking.count({ where: { requesterId, ...(status ? { status } : {}) } }),
  ])

  return { bookings, total, page, limit, totalPages: Math.ceil(total / limit) }
}
