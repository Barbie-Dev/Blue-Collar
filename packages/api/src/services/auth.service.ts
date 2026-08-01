import { db as defaultDb } from '../db.js'
import argon2 from 'argon2'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import { sendVerificationEmail, sendPasswordResetEmail } from '../mailer/index.js'
import { AppError } from './AppError.js'
import { sanitizeUser } from '../models/user.model.js'
import { createServiceLogger } from '../utils/logger.js'
import type { LoginBody, RegisterBody } from '../interfaces/index.js'
import * as OTPAuth from 'otpauth'
import { userRepository as defaultUserRepository } from '../repositories/user.repository.js'
import type { AuthServiceDeps } from '../container/types.js'

const logger = createServiceLogger('AuthService')
const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL_DAYS = 7

/**
 * Generate a short-lived email verification token for a user.
 */
function generateVerificationToken(userId: string) {
  const raw = jwt.sign({ id: userId, purpose: 'email-verify' }, process.env.JWT_SECRET!, {
    expiresIn: '24h',
  })
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000)
  return { raw, hash, expiry }
}

/**
 * Generate a refresh token: raw random bytes + its SHA-256 hash + expiry.
 */
function generateRefreshToken() {
  const raw = crypto.randomBytes(40).toString('hex')
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  return { raw, hash, expiresAt }
}

// ── Service factory ──────────────────────────────────────────────────────────

/**
 * Create an auth service with injected dependencies.
 *
 * Enables clean unit testing:
 * ```ts
 * const mockRepo  = { findByEmail: vi.fn(), findById: vi.fn(), create: vi.fn(), update: vi.fn() }
 * const mockMailer = { sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }
 * const mockDb     = { refreshToken: { create: vi.fn(), ... }, device: { create: vi.fn() } }
 * const svc = createAuthService({ userRepository: mockRepo, mailer: mockMailer, db: mockDb })
 * ```
 */
export function createAuthService(deps: AuthServiceDeps) {
  const { userRepository, mailer, db } = deps

  return {
    /**
     * Authenticate a user with email and password.
     */
    async loginUser(
      { email, password }: LoginBody,
      deviceName?: string,
      userAgent?: string,
      ipAddress?: string,
    ) {
      logger.debug('Login attempt', { email })
      const user = await userRepository.findByEmail(email)
      if (!user || !user.password || !(await argon2.verify(user.password, password))) {
        logger.warn('Login failed: invalid credentials', { email })
        throw new AppError('Invalid credentials', 401)
      }
      if (!user.verified) {
        logger.warn('Login failed: email not verified', { email })
        throw new AppError(
          'Your email address has not been verified. Please check your inbox and click the verification link.',
          403,
        )
      }

      const accessToken = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET!, {
        expiresIn: ACCESS_TOKEN_TTL,
      })

      const { raw: refreshTokenRaw, hash: refreshTokenHash, expiresAt } = generateRefreshToken()
      await db.refreshToken.create({ data: { userId: user.id, tokenHash: refreshTokenHash, expiresAt } })

      let deviceId: string | undefined
      if (deviceName && ipAddress) {
        const device = await db.device.create({
          data: { userId: user.id, deviceName, userAgent, ipAddress },
        })
        deviceId = (device as { id: string }).id
      }

      logger.info('User logged in successfully', { userId: user.id, email })
      return { data: sanitizeUser(user), token: accessToken, refreshToken: refreshTokenRaw, deviceId }
    },

    /**
     * Exchange a valid refresh token for a new access token + refresh token pair.
     */
    async rotateRefreshToken(rawToken: string) {
      const hash = crypto.createHash('sha256').update(rawToken).digest('hex')
      const stored = await db.refreshToken.findUnique({ where: { tokenHash: hash } }) as {
        id: string; revokedAt: Date | null; expiresAt: Date; userId: string
      } | null

      if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
        throw new AppError('Invalid or expired refresh token', 401)
      }

      await db.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } })

      const user = await userRepository.findById(stored.userId)
      if (!user) throw new AppError('User not found', 404)

      const accessToken = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET!, {
        expiresIn: ACCESS_TOKEN_TTL,
      })

      const { raw: newRefreshRaw, hash: newRefreshHash, expiresAt } = generateRefreshToken()
      await db.refreshToken.create({ data: { userId: user.id, tokenHash: newRefreshHash, expiresAt } })

      return { token: accessToken, refreshToken: newRefreshRaw }
    },

    /**
     * Revoke all refresh tokens for a user (called on logout).
     */
    async revokeAllRefreshTokens(userId: string) {
      await db.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    },

    /**
     * Register a new user account and send a verification email.
     */
    async registerUser({ email, password, firstName, lastName }: RegisterBody) {
      logger.debug('Registration attempt', { email })
      const existing = await userRepository.findByEmail(email)
      if (existing) {
        logger.warn('Registration failed: email already in use', { email })
        throw new AppError('Email already in use', 409)
      }

      const hashed = await argon2.hash(password)
      const user = await userRepository.create({ email, password: hashed, firstName, lastName })

      const { raw, hash, expiry } = generateVerificationToken(user.id)
      await userRepository.update(user.id, { verificationToken: hash, verificationTokenExpiry: expiry })

      mailer.sendVerificationEmail(email, firstName, raw).catch((err: unknown) =>
        logger.error('Failed to send verification email', err),
      )

      logger.info('User registered successfully', { userId: user.id, email })
      return sanitizeUser(user)
    },

    /**
     * Verify a user's email address using the raw JWT from the verification email.
     */
    async verifyAccount(token: string): Promise<boolean> {
      logger.debug('Email verification attempt')
      let payload: { id?: string; purpose?: string }
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET!) as { id: string; purpose: string }
      } catch {
        logger.warn('Email verification failed: invalid token')
        throw new AppError('Token is invalid or has expired', 400)
      }

      if (payload.purpose !== 'email-verify' || !payload.id) {
        throw new AppError('Invalid verification token', 400)
      }

      const user = await userRepository.findById(payload.id)
      if (!user) throw new AppError('User not found', 404)
      if (user.verified) return false

      const incomingHash = crypto.createHash('sha256').update(token).digest('hex')
      const valid =
        incomingHash === user.verificationToken &&
        user.verificationTokenExpiry &&
        user.verificationTokenExpiry > new Date()

      if (!valid) throw new AppError('Token is invalid or has expired', 400)

      await userRepository.update(user.id, { verified: true, verificationToken: null, verificationTokenExpiry: null })
      logger.info('Email verified successfully', { userId: user.id })
      return true
    },

    /**
     * Resend a verification email to an unverified account.
     */
    async resendVerificationEmail(email: string) {
      const user = await userRepository.findByEmail(email)
      if (!user || user.verified) return

      const { raw, hash, expiry } = generateVerificationToken(user.id)
      await userRepository.update(user.id, { verificationToken: hash, verificationTokenExpiry: expiry })

      mailer.sendVerificationEmail(email, user.firstName, raw).catch((err: unknown) =>
        logger.error('Failed to resend verification email', err),
      )
    },

    /**
     * Initiate a password reset flow.
     */
    async requestPasswordReset(email: string) {
      const user = await userRepository.findByEmail(email)
      if (!user) return

      const rawToken = crypto.randomBytes(32).toString('hex')
      const hash = crypto.createHash('sha256').update(rawToken).digest('hex')
      const expiry = new Date(Date.now() + 60 * 60 * 1000)

      await userRepository.update(user.id, { resetToken: hash, resetTokenExpiry: expiry })

      mailer.sendPasswordResetEmail(user.email, user.firstName, rawToken).catch((err: unknown) =>
        logger.error('Failed to send password reset email', err),
      )
    },

    /**
     * Reset a user's password using the raw token from the reset email.
     */
    async resetPassword(token: string, password: string) {
      const hash = crypto.createHash('sha256').update(token).digest('hex')
      const user = await userRepository.findByResetToken(hash)
      if (!user) throw new AppError('Token is invalid or has expired', 400)

      const hashedPassword = await argon2.hash(password)

      await db.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })

      await db.device.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })

      await userRepository.update(user.id, { password: hashedPassword, resetToken: null, resetTokenExpiry: null })
      logger.info('Password reset successfully - all sessions revoked', { userId: user.id })
    },
  }
}

// ── Default service instance (backward-compatible module-level API) ───────────

const _defaultService = createAuthService({
  userRepository: defaultUserRepository,
  mailer: { sendVerificationEmail, sendPasswordResetEmail },
  db: defaultDb,
})

export async function loginUser(
  body: LoginBody,
  deviceName?: string,
  userAgent?: string,
  ipAddress?: string,
) {
  return _defaultService.loginUser(body, deviceName, userAgent, ipAddress)
}

export async function rotateRefreshToken(rawToken: string) {
  return _defaultService.rotateRefreshToken(rawToken)
}

export async function revokeAllRefreshTokens(userId: string) {
  return _defaultService.revokeAllRefreshTokens(userId)
}

export async function registerUser(body: RegisterBody) {
  return _defaultService.registerUser(body)
}

export async function verifyAccount(token: string): Promise<boolean> {
  return _defaultService.verifyAccount(token)
}

export async function resendVerificationEmail(email: string) {
  return _defaultService.resendVerificationEmail(email)
}

export async function requestPasswordReset(email: string) {
  return _defaultService.requestPasswordReset(email)
}

export async function resetPassword(token: string, password: string) {
  return _defaultService.resetPassword(token, password)
}

// ── 2FA functions remain independent (no DI needed - they only use userRepository) ──

export async function generateTOTPSecret(userId: string) {
  const user = await defaultUserRepository.findById(userId)
  if (!user) throw new AppError('User not found', 404)
  if (user.twoFactorEnabled) throw new AppError('2FA is already enabled', 409)

  const secret = new OTPAuth.Secret({ size: 32 })
  const totp = new OTPAuth.TOTP({
    issuer: 'BlueCollar',
    label: `BlueCollar (${user.email})`,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  })

  return {
    secret: secret.base32,
    qrCode: totp.toString(),
  }
}

export async function enableTwoFactorAuth(userId: string, totpCode: string, secret: string) {
  const user = await defaultUserRepository.findById(userId)
  if (!user) throw new AppError('User not found', 404)

  const totp = new OTPAuth.TOTP({
    issuer: 'BlueCollar',
    label: `BlueCollar (${user.email})`,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  })

  const isValid = totp.validate({ token: totpCode, window: 1 })
  if (!isValid) throw new AppError('Invalid TOTP code', 400)

  const backupCodes = Array.from({ length: 10 }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase(),
  )

  await defaultUserRepository.update(userId, {
    twoFactorSecret: secret,
    twoFactorEnabled: true,
    twoFactorBackupCodes: backupCodes,
  })

  return { backupCodes }
}

export async function verifyTOTPCode(userId: string, code: string) {
  const user = await defaultUserRepository.findById(userId)
  if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
    throw new AppError('2FA not enabled for this user', 400)
  }

  if (user.twoFactorBackupCodes && user.twoFactorBackupCodes.includes(code)) {
    const updated = user.twoFactorBackupCodes.filter((c) => c !== code)
    await defaultUserRepository.update(userId, { twoFactorBackupCodes: updated })
    return true
  }

  const totp = new OTPAuth.TOTP({
    issuer: 'BlueCollar',
    label: `BlueCollar (${user.email})`,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(user.twoFactorSecret),
  })

  return !!totp.validate({ token: code, window: 1 })
}

export async function disableTwoFactorAuth(userId: string) {
  await defaultUserRepository.update(userId, {
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactorBackupCodes: [],
  })
}
