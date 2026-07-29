import { db } from '../db.js'
import { AppError, ErrorCode } from '../utils/AppError.js'

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

  // Find native XLM balance
  const nativeBalance = data.balances.find((b) => b.asset_type === 'native')
  const balance = nativeBalance ? parseFloat(nativeBalance.balance) : 0

  return {
    publicKey,
    balance,
    sequence: BigInt(data.sequence),
  }
}

/**
 * Sync or create a Stellar account for a user.
 * Fetches current balance and sequence from Horizon.
 */
export async function syncStellarAccount(userId: string, publicKey: string) {
  const accountInfo = await getAccountInfo(publicKey)

  return db.stellarAccount.upsert({
    where: { publicKey },
    update: {
      balance: accountInfo.balance,
      sequences: accountInfo.sequence,
      lastSyncedAt: new Date(),
    },
    create: {
      publicKey,
      userId,
      balance: accountInfo.balance,
      sequences: accountInfo.sequence,
      lastSyncedAt: new Date(),
    },
  })
}

/**
 * Get cached balance for a user's Stellar account.
 */
export async function getUserBalance(userId: string) {
  const account = await db.stellarAccount.findFirst({
    where: { userId },
  })

  if (!account) {
    throw new AppError('Stellar account not linked', 404, true, ErrorCode.NOT_FOUND)
  }

  return {
    publicKey: account.publicKey,
    balance: account.balance,
    lastSyncedAt: account.lastSyncedAt,
  }
}

/**
 * Build an unsigned transaction XDR for a tip/payment.
 * Returns transaction envelope that client signs and broadcasts.
 *
 * This is a helper to construct the transaction details.
 * For full XDR encoding, clients should use stellar-sdk or stellar-base.
 */
export async function buildUnsignedTx(
  sourcePublicKey: string,
  destinationPublicKey: string,
  amount: string,
  memo?: string,
) {
  const account = await db.stellarAccount.findUnique({
    where: { publicKey: sourcePublicKey },
  })

  if (!account) {
    throw new AppError('Source account not found', 404, true, ErrorCode.NOT_FOUND)
  }

  // Fetch latest sequence to avoid gaps
  const current = await getAccountInfo(sourcePublicKey)
  const nextSequence = (current.sequence + BigInt(1)).toString()

  // Return transaction parameters for client to build XDR
  // Client should use stellar-sdk: new TransactionBuilder(account)
  //   .addOperation(Operation.payment({ destination, asset, amount }))
  //   .build()
  return {
    sourcePublicKey,
    destinationPublicKey,
    amount,
    memo: memo || '',
    sequence: nextSequence,
    // Note: xdr is signed by client, not generated here
    description: 'Use stellar-sdk to sign this transaction and then broadcast',
  }
}

/**
 * Submit a signed XDR transaction to Stellar network.
 * @param signedXdr Base64-encoded signed transaction envelope
 * @returns Transaction hash and ID
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
  return {
    txHash: result.hash,
    txId: result.id,
  }
}

/**
 * Poll transaction status from Horizon.
 * Returns status: pending | confirmed | failed
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
 * Only works on testnet — do not call on mainnet.
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
 * Register a user's Stellar account for the first time.
 * Links wallet to user profile and syncs balance.
 */
export async function linkStellarAccount(userId: string, publicKey: string) {
  // Verify account exists on network
  await getAccountInfo(publicKey)

  // Check if already linked to another user
  const existing = await db.stellarAccount.findUnique({
    where: { publicKey },
  })

  if (existing && existing.userId !== userId) {
    throw new AppError('Wallet already linked to another account', 409, true, ErrorCode.CONFLICT)
  }

  return syncStellarAccount(userId, publicKey)
}

/**
 * Get transaction history for a Stellar account from Horizon.
 * @param publicKey Account's public key
 * @param limit Max results (default 50)
 * @param order Sort order: asc or desc (default desc)
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

