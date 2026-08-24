import { walletRepository as defaultWalletRepository } from '../repositories/wallet.repository.js'
import { AppError, ErrorCode } from '../utils/AppError.js'
import type { WalletServiceDeps } from '../container/types.js'

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org'
const FRIENDBOT_URL = 'https://friendbot-testnet.stellar.org/bump_sequence'

/**
 * Maps an upstream Horizon/friendbot HTTP status to an application ErrorCode
 * so failures surface with a consistent error contract regardless of origin.
 */
function upstreamErrorCode(status: number): ErrorCode {
  if (status === 404) return ErrorCode.NOT_FOUND
  if (status >= 500) return ErrorCode.SERVICE_UNAVAILABLE
  return ErrorCode.VALIDATION_ERROR
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createWalletService(deps: WalletServiceDeps) {
  const { walletRepository: repo } = deps

  return {
    /**
     * Sync or create a Stellar account for a user.
     * Fetches current balance and sequence from Horizon.
     */
    async syncStellarAccount(userId: string, publicKey: string) {
      const accountInfo = await getAccountInfo(publicKey)

      return repo.upsertAccount(publicKey, userId, accountInfo.balance, accountInfo.sequence)
    },

    /**
     * Get cached balance for a user's Stellar account.
     */
    async getUserBalance(userId: string) {
      const account = await repo.findByUserId(userId)

      if (!account) {
        throw new AppError('Stellar account not linked', 404, true, ErrorCode.NOT_FOUND)
      }

      return {
        publicKey: account.publicKey,
        balance: account.balance,
        lastSyncedAt: account.lastSyncedAt,
      }
    },

    /**
     * Build an unsigned transaction XDR for a tip/payment.
     */
    async buildUnsignedTx(
      sourcePublicKey: string,
      destinationPublicKey: string,
      amount: string,
      memo?: string,
    ) {
      const account = await repo.findByPublicKey(sourcePublicKey)

      if (!account) {
        throw new AppError('Source account not found', 404, true, ErrorCode.NOT_FOUND)
      }

      const current = await getAccountInfo(sourcePublicKey)
      const nextSequence = (current.sequence + BigInt(1)).toString()

      return {
        sourcePublicKey,
        destinationPublicKey,
        amount,
        memo: memo || '',
        sequence: nextSequence,
        description: 'Use stellar-sdk to sign this transaction and then broadcast',
      }
    },

    /**
     * Register a user's Stellar account for the first time.
     */
    async linkStellarAccount(userId: string, publicKey: string) {
      await getAccountInfo(publicKey)

      const existing = await repo.findByPublicKey(publicKey)

      if (existing && existing.userId !== userId) {
        throw new AppError('Wallet already linked to another account', 409, true, ErrorCode.CONFLICT)
      }

      const accountInfo = await getAccountInfo(publicKey)
      return repo.upsertAccount(publicKey, userId, accountInfo.balance, accountInfo.sequence)
    },
  }
}

// ── Standalone Horizon/network helpers (no DB involvement) ────────────────────

/**
 * Fetch account balance and sequence from Horizon.
 * @throws AppError if account not found or network error
 */
export async function getAccountInfo(publicKey: string) {
  const response = await fetch(`${HORIZON_URL}/accounts/${publicKey}`)

  if (response.status === 404) {
    throw new AppError('Account not found on Stellar network', 404, true, ErrorCode.NOT_FOUND)
  }

  if (!response.ok) {
    throw new AppError(
      `Stellar network error: ${response.statusText}`,
      response.status,
      true,
      upstreamErrorCode(response.status),
    )
  }

  const data = (await response.json()) as {
    balances: Array<{ balance: string; asset_type: string }>
    sequence: string
  }

  const nativeBalance = data.balances.find((b) => b.asset_type === 'native')
  const balance = nativeBalance ? parseFloat(nativeBalance.balance) : 0

  return {
    publicKey,
    balance,
    sequence: BigInt(data.sequence),
  }
}

/**
 * Submit a signed XDR transaction to Stellar network.
 */
export async function broadcastTransaction(signedXdr: string) {
  const response = await fetch(`${HORIZON_URL}/transactions`, {
    method: 'POST',
    body: new URLSearchParams({ tx: signedXdr }),
  })

  if (!response.ok) {
    const error = (await response.json()) as { title?: string; detail?: string }
    throw new AppError(
      `Broadcast failed: ${error.detail || error.title}`,
      response.status,
      true,
      upstreamErrorCode(response.status),
    )
  }

  const result = (await response.json()) as { hash: string; id: string }
  return { txHash: result.hash, txId: result.id }
}

/**
 * Poll transaction status from Horizon.
 */
export async function pollTransactionStatus(txHash: string) {
  const response = await fetch(`${HORIZON_URL}/transactions/${txHash}`)

  if (response.status === 404) {
    return { status: 'pending' }
  }

  if (!response.ok) {
    throw new AppError(
      'Failed to fetch transaction status',
      response.status,
      true,
      upstreamErrorCode(response.status),
    )
  }

  const tx = (await response.json()) as { successful: boolean; result_code: string }

  return {
    status: tx.successful ? 'confirmed' : 'failed',
    resultCode: tx.result_code,
  }
}

/**
 * Fund testnet account via friendbot.
 */
export async function fundTestnetAccount(publicKey: string) {
  const response = await fetch(FRIENDBOT_URL, {
    method: 'POST',
    body: JSON.stringify({ account: publicKey }),
    headers: { 'Content-Type': 'application/json' },
  })

  if (!response.ok) {
    const error = (await response.json()) as { error?: string }
    throw new AppError(
      `Friendbot failed: ${error.error || response.statusText}`,
      response.status,
      true,
      upstreamErrorCode(response.status),
    )
  }

  const result = (await response.json()) as { hash: string }
  return { txHash: result.hash, message: 'Account funded successfully' }
}

/**
 * Get transaction history for a Stellar account from Horizon.
 */
export async function getAccountTransactions(
  publicKey: string,
  limit = 50,
  order: 'asc' | 'desc' = 'desc',
) {
  const response = await fetch(
    `${HORIZON_URL}/accounts/${publicKey}/transactions?limit=${limit}&order=${order}`,
  )

  if (!response.ok) {
    throw new AppError(
      'Failed to fetch transactions',
      response.status,
      true,
      upstreamErrorCode(response.status),
    )
  }

  const data = (await response.json()) as {
    _embedded: { records: Array<{ hash: string; created_at: string }> }
  }

  return data._embedded.records
}

// ── Default service instance (backward-compatible module-level API) ───────────

const _defaultService = createWalletService({
  walletRepository: defaultWalletRepository,
})

export async function syncStellarAccount(userId: string, publicKey: string) {
  return _defaultService.syncStellarAccount(userId, publicKey)
}

export async function getUserBalance(userId: string) {
  return _defaultService.getUserBalance(userId)
}

export async function buildUnsignedTx(
  sourcePublicKey: string,
  destinationPublicKey: string,
  amount: string,
  memo?: string,
) {
  return _defaultService.buildUnsignedTx(sourcePublicKey, destinationPublicKey, amount, memo)
}

export async function linkStellarAccount(userId: string, publicKey: string) {
  return _defaultService.linkStellarAccount(userId, publicKey)
}
