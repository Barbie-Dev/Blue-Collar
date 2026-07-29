import { z } from 'zod'
import { emailField, nameField, passwordField } from './shared.js'

// PATCH /users/me
export const updateProfileRules = z.object({
  firstName: nameField.max(50).optional(),
  lastName: nameField.max(50).optional(),
  email: emailField.optional(),
})

// PUT /users/me/password
export const changePasswordRules = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordField,
})

// POST /users/me/push-subscription
export const pushSubscriptionRules = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    auth: z.string().min(1),
    p256dh: z.string().min(1),
  }),
})
