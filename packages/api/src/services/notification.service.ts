import { db } from '../db.js'
import { AppError } from './AppError.js'
import { logger } from '../config/logger.js'
import { mailer } from '../mailer/index.js'
import * as pushService from './push.service.js'

interface NotificationPayload {
  userId: string
  type: string
  title: string
  message: string
  channels?: ('email' | 'push' | 'inapp')[]
  href?: string
  data?: Record<string, string>
}

interface DeliveryLog {
  notificationId: string
  userId: string
  channel: string
  status: 'sent' | 'failed'
  error?: string
  sentAt: Date
}

const deliveryCache = new Map<string, DeliveryLog[]>()
const DEDUP_WINDOW = 60000 // 1 minute

const DEFAULT_PREFERENCES = {
  newWorkerNearby: true,
  statusChange: true,
  reviewReply: true,
  announcements: true,
}

export async function dispatchNotification(payload: NotificationPayload): Promise<void> {
  // Users without a persisted preferences row (e.g. anyone who hasn't visited
  // the preferences page yet) should still receive notifications by default —
  // falling back here instead of no-op'ing keeps first-time delivery working.
  const prefs = (await db.notificationPreferences.findUnique({
    where: { userId: payload.userId },
  })) ?? DEFAULT_PREFERENCES

  const channels = payload.channels || ['email', 'push', 'inapp']
  const dedupKey = `${payload.userId}:${payload.type}:${payload.message}`
  
  // Check deduplication
  if (isDuplicate(dedupKey)) {
    logger.info({ dedupKey }, 'Notification deduplicated')
    return
  }

  // Always create in-app notification
  const notification = await db.notification.create({
    data: {
      userId: payload.userId,
      type: payload.type,
      title: payload.title,
      message: payload.message,
      href: payload.href,
    },
  })

  const logs: DeliveryLog[] = []

  if (channels.includes('email') && shouldSendEmail(prefs, payload.type)) {
    try {
      await sendEmailNotification(payload)
      logs.push({
        notificationId: notification.id,
        userId: payload.userId,
        channel: 'email',
        status: 'sent',
        sentAt: new Date(),
      })
    } catch (error) {
      logger.error({ error, userId: payload.userId }, 'Email notification failed')
      logs.push({
        notificationId: notification.id,
        userId: payload.userId,
        channel: 'email',
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        sentAt: new Date(),
      })
    }
  }

  if (channels.includes('push') && shouldSendPush(prefs, payload.type)) {
    try {
      await pushService.sendPushNotification(payload.userId, {
        title: payload.title,
        body: payload.message,
        tag: payload.type,
      })
      logs.push({
        notificationId: notification.id,
        userId: payload.userId,
        channel: 'push',
        status: 'sent',
        sentAt: new Date(),
      })
    } catch (error) {
      logger.error({ error, userId: payload.userId }, 'Push notification failed')
      logs.push({
        notificationId: notification.id,
        userId: payload.userId,
        channel: 'push',
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        sentAt: new Date(),
      })
    }
  }

  // Store delivery logs
  storeDeliveryLog(notification.id, logs)
}

async function sendEmailNotification(payload: NotificationPayload): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: { email: true, firstName: true },
  })

  if (!user) throw new AppError('User not found', 404)

  await mailer.send({
    to: user.email,
    subject: payload.title,
    text: payload.message,
    html: `<p>${payload.message}</p>${payload.href ? `<a href="${payload.href}">View</a>` : ''}`,
  })
}

/**
 * Minimal view of a user's notification preferences that the dispatch gates
 * depend on. Both a persisted `NotificationPreferences` row and the in-memory
 * `DEFAULT_PREFERENCES` fallback satisfy this shape.
 */
interface NotificationPrefsView {
  reviewReply: boolean
  announcements: boolean
}

function shouldSendEmail(prefs: NotificationPrefsView, type: string): boolean {
  // Keyed on the real NotificationType enum values (tip/review/contact/system/message) —
  // 'worker_nearby'/'status_change'/'review_reply'/'announcement' never match any
  // actual dispatch call site (every caller uses 'system'), so preferences never
  // took effect. 'newWorkerNearby'/'statusChange' have no corresponding enum
  // value yet, so they stay unmapped (default-on) until that type exists.
  const typeMap: Record<string, keyof NotificationPrefsView> = {
    'review': 'reviewReply',
    'system': 'announcements',
  }
  const key = typeMap[type]
  return key ? prefs[key] : true
}

function shouldSendPush(prefs: NotificationPrefsView, type: string): boolean {
  // Always send push for important notifications
  return !['review'].includes(type) || prefs.reviewReply
}

function isDuplicate(dedupKey: string): boolean {
  const cached = deliveryCache.get(dedupKey)
  if (cached && Date.now() - cached[0].sentAt.getTime() < DEDUP_WINDOW) {
    return true
  }
  return false
}

function storeDeliveryLog(notificationId: string, logs: DeliveryLog[]): void {
  const key = notificationId
  deliveryCache.set(key, logs)
  
  // Cleanup old entries after dedup window
  setTimeout(() => {
    deliveryCache.delete(key)
  }, DEDUP_WINDOW)
}

export async function getDeliveryLog(notificationId: string): Promise<DeliveryLog[] | null> {
  const user = await db.notification.findUnique({
    where: { id: notificationId },
    select: { id: true },
  })
  if (!user) return null
  return deliveryCache.get(notificationId) || []
}

export async function updateNotificationPreferences(
  userId: string,
  preferences: Partial<{
    newWorkerNearby: boolean
    statusChange: boolean
    reviewReply: boolean
    announcements: boolean
    quietHoursStart?: string
    quietHoursEnd?: string
  }>
): Promise<void> {
  await db.notificationPreferences.upsert({
    where: { userId },
    create: { userId, ...preferences },
    update: preferences,
  })
}

export async function isInQuietHours(userId: string): Promise<boolean> {
  const prefs = await db.notificationPreferences.findUnique({ where: { userId } })
  if (!prefs) return false

  // Simple implementation - can be extended with specific quiet hours
  const hour = new Date().getHours()
  return hour >= 22 || hour < 8 // Default quiet hours: 10 PM - 8 AM
}

