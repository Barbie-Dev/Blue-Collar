// ─── Core domain types ────────────────────────────────────────────────────────

export interface Category {
  id: string;
  name: string;
  icon?: string | null;
  description?: string | null;
}

export interface PortfolioImage {
  id: string;
  url: string;
  caption?: string | null;
  order?: number;
}

export interface Worker {
  id: string;
  name: string;
  bio?: string | null;
  avatar?: string | null;
  phone?: string | null;
  email?: string | null;
  location?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isVerified: boolean;
  isActive: boolean;
  locationId?: string | null;
  walletAddress?: string | null;
  categoryId?: string;
  category?: Category;
  averageRating?: number | null;
  reviewCount?: number;
  portfolioImages?: PortfolioImage[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface Review {
  id: string;
  rating: number;
  comment?: string | null;
  workerId: string;
  authorId: string;
  createdAt: string;
  author: {
    id: string;
    firstName: string;
    lastName: string;
    avatar?: string | null;
  };
}

// ─── Auth types ───────────────────────────────────────────────────────────────

/** Authenticated user shape returned from /auth/me and stored in AuthContext. */
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "user" | "curator" | "admin";
  verified: boolean;
  avatar?: string | null;
  onboardingCompleted?: boolean;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

// Alias for backward compatibility
export interface AuthUser extends User {}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface Meta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface RatingDistributionEntry {
  rating: number;
  count: number;
  percentage: number;
}

// ─── API response wrappers ────────────────────────────────────────────────────

/** Standard API envelope returned by all endpoints. */
export interface ApiResponse<T> {
  data: T;
  meta?: Meta;
  status: string;
  code: number;
  message?: string;
}

/** Paginated list response. */
export type PaginatedResponse<T> = ApiResponse<T[]> & { meta: Meta };

// ─── Form types ───────────────────────────────────────────────────────────────

export interface LoginForm {
  email: string;
  password: string;
}

export interface RegisterForm {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export interface WorkerForm {
  name: string;
  bio?: string;
  phone?: string;
  email?: string;
  location?: string;
  categoryId: string;
  walletAddress?: string;
}

// ─── Stellar/SDK types ───────────────────────────────────────────────────────

export interface AccountInfo {
  publicKey: string;
  balance: number;
  sequence: bigint;
}

export interface BroadcastResult {
  txHash: string;
  txId: string;
}

export interface TxStatus {
  status: 'pending' | 'confirmed' | 'failed';
  resultCode?: string;
}

export interface WorkerRegistration {
  workerId: string;
  contractId: string;
}

export interface ReputationSync {
  workerId: string;
  avgRating: number;
  reviewCount: number;
  reputation: number;
}

export interface SdkConfig {
  horizonUrl: string;
  registryContractId?: string;
  marketContractId?: string;
  network: 'testnet' | 'mainnet';
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  action: string;
  userId: string;
  metadata: Record<string, any>;
  createdAt: string;
}