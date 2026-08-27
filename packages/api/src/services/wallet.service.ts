import { walletRepository as defaultWalletRepository } from '../repositories/wallet.repository.js'
import { AppError } from '../utils/AppError.js'
import type { WalletServiceDeps } from '../container/types.js'
import { stellarRpcClient } from './stellar-rpc.client.js'

// ── Factory ───────────────────────────────────────────────────────────────────

export function createWalletService(deps: WalletServiceDeps) {
  const { walletRepository: repo } = deps

  return {
    /**
     * Sync or create a Stellar account for a user.
     * Fetches current balance and sequence from Horizon.
     */
    async syncStellarAccount(userId: string, publicKey: string) {
      const accountInfo = await stellarRpcClient.getAccountInfo(publicKey)

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
      await stellarRpcClient.getAccountInfo(publicKey)

      const existing = await repo.findByPublicKey(publicKey)

      if (existing && existing.userId !== userId) {
        throw new AppError('Wallet already linked to another account', 409, true, ErrorCode.CONFLICT)
      }

      const accountInfo = await stellarRpcClient.getAccountInfo(publicKey)
      return repo.upsertAccount(publicKey, userId, accountInfo.balance, accountInfo.sequence)
    },
  }
}

// ── Standalone Horizon/network helpers (delegate to StellarRpcClient) ────────────

/**
 * Fetch account balance and sequence from Horizon.
 */
export async function getAccountInfo(publicKey: string) {
  return stellarRpcClient.getAccountInfo(publicKey)
}

/**
 * Submit a signed XDR transaction to Stellar network.
 */
export async function broadcastTransaction(signedXdr: string) {
  return stellarRpcClient.broadcastTransaction(signedXdr)
}

/**
 * Poll transaction status from Horizon.
 */
export async function pollTransactionStatus(txHash: string) {
  return stellarRpcClient.pollTransactionStatus(txHash)
}

/**
 * Fund testnet account via friendbot.
 */
export async function fundTestnetAccount(publicKey: string) {
  return stellarRpcClient.fundTestnetAccount(publicKey)
}

/**
 * Get transaction history for a Stellar account from Horizon.
 */
export async function getAccountTransactions(
  publicKey: string,
  limit = 50,
  order: 'asc' | 'desc' = 'desc',
) {
  return stellarRpcClient.getAccountTransactions(publicKey, limit, order)
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
