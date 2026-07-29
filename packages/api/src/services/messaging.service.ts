import { db } from '../db.js'
import { AppError, ErrorCode } from '../utils/AppError.js'

export async function createConversation(participantIds: string[], subject?: string) {
  const conversation = await db.conversation.create({
    data: {
      subject,
      participants: {
        create: participantIds.map(id => ({ userId: id })),
      },
    },
    include: { participants: true },
  })
  return conversation
}

export async function getConversation(conversationId: string, userId: string) {
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      participants: { some: { userId } },
    },
    include: {
      participants: { include: { user: { select: { id: true, firstName: true, lastName: true, avatar: true } } } },
      messages: { take: 50, orderBy: { createdAt: 'asc' } },
    },
  })
  if (!conversation) throw new AppError('Conversation not found', 404, true, ErrorCode.NOT_FOUND)
  return conversation
}

export async function getUserConversations(userId: string, page: number = 1, limit: number = 20) {
  const skip = (page - 1) * limit
  const [conversations, total] = await Promise.all([
    db.conversation.findMany({
      where: { participants: { some: { userId } } },
      include: {
        participants: true,
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
    }),
    db.conversation.count({ where: { participants: { some: { userId } } } }),
  ])
  return {
    data: conversations,
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  }
}

export async function searchMessages(conversationId: string, query: string, userId: string) {
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      participants: { some: { userId } },
    },
  })
  if (!conversation) throw new AppError('Conversation not found', 404, true, ErrorCode.NOT_FOUND)

  return db.message.findMany({
    where: {
      conversationId,
      body: { search: query.split(' ').join(' | ') },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
}

export async function deleteMessage(messageId: string, userId: string) {
  const message = await db.message.findUnique({ where: { id: messageId } })
  if (!message) throw new AppError('Message not found', 404, true, ErrorCode.NOT_FOUND)
  if (message.senderId !== userId) throw new AppError('Unauthorized', 403, true, ErrorCode.FORBIDDEN)

  // Soft delete by setting body
  return db.message.update({
    where: { id: messageId },
    data: { body: '[deleted]' },
  })
}

export async function markConversationAsRead(conversationId: string, userId: string) {
  return db.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: new Date() },
  })
}

export async function getUnreadCount(userId: string) {
  const conversations = await db.conversation.findMany({
    where: { participants: { some: { userId } } },
    include: {
      participants: { where: { userId } },
      messages: { where: { createdAt: { gt: { lastReadAt: {} } } } },
    },
  })

  return conversations.reduce((count, conv) => {
    const participant = conv.participants[0]
    if (!participant?.lastReadAt) return count + conv.messages.length
    return count + conv.messages.filter(m => m.createdAt > participant.lastReadAt!).length
  }, 0)
}
