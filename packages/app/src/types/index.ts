// Re-export shared types from @bluecollar/types
export type {
  Category,
  PortfolioImage,
  Worker,
  Review,
  User,
  AuthUser,
  Meta,
  RatingDistributionEntry,
  ApiResponse,
  PaginatedResponse,
  LoginForm,
  RegisterForm,
  WorkerForm,
  AuditLogEntry
} from '@bluecollar/types'

// ── Analytics types ──────────────────────────────────────────────────────────

export interface WorkerAnalytics {
  workerId: string;
  workerName: string;
  category: string;
  totalViews: number;
  uniqueViews: number;
  viewsLast30Days: number;
  totalTips: number;
  tipCount: number;
  bookmarkCount: number;
  contactCount: number;
  contactsLast30Days: number;
  responseRate: number;
  avgRating: number;
  reviewCount: number;
  updatedAt: string | null;
}

export interface WorkerSummary {
  id: string;
  name: string;
  category: string;
  isActive: boolean;
  views: number;
  uniqueViews: number;
  tips: number;
  tipCount: number;
  bookmarks: number;
  contacts: number;
}

export interface CuratorAnalytics {
  totalWorkers: number;
  activeWorkers: number;
  workers: WorkerSummary[];
  totals: {
    views: number;
    uniqueViews: number;
    tips: number;
    tipCount: number;
    bookmarks: number;
    contacts: number;
    avgRating: number;
    reviewCount: number;
    contactsThisMonth: number;
    viewsThisMonth: number;
  };
}

export interface PlatformAnalytics {
  overview: {
    totalWorkers: number;
    activeWorkers: number;
    totalUsers: number;
    totalCurators: number;
  };
  engagement: {
    totalViews: number;
    viewsThisMonth: number;
    totalReviews: number;
    reviewsThisMonth: number;
    totalContacts: number;
    contactsThisMonth: number;
  };
  revenue: {
    totalTips: number;
    totalTipCount: number;
  };
  growth: {
    workersThisMonth: number;
    workersLastMonth: number;
    workerGrowthPct: number;
    usersThisMonth: number;
    usersLastMonth: number;
    userGrowthPct: number;
  };
  trends: {
    userGrowth: Array<{ month: string; count: number }>;
    workerGrowth: Array<{ month: string; count: number }>;
  };
  topCategories: Array<{ name: string; count: number }>;
  recentWorkers: Array<{
    id: string;
    name: string;
    createdAt: string;
    category: { name: string };
  }>;
  recentUsers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    createdAt: string;
    role: string;
  }>;
}

export interface ViewTrend {
  date: string;
  views: number;
}

export interface TopWorker {
  rank: number;
  workerId: string;
  workerName: string;
  category: string;
  totalViews: number;
  totalTips: number;
  bookmarkCount: number;
  avgRating: number;
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export type JobStatus = "open" | "closed" | "expired" | "filled";
export type JobUrgency = "low" | "normal" | "urgent";
export type ApplicationStatus = "pending" | "accepted" | "rejected" | "withdrawn";

export interface Job {
  id: string;
  title: string;
  description: string;
  budget?: number | null;
  skills: string[];
  urgency: JobUrgency;
  escrowAmount?: number | null;
  escrowTxId?: string | null;
  status: JobStatus;
  expiresAt?: string | null;
  renewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  category: Category;
  location?: { id: string; city: string; state?: string | null; country: string } | null;
  postedBy: { id: string; firstName: string; lastName: string; avatar?: string | null };
  _count?: { applications: number; messages: number };
}

export interface JobApplication {
  id: string;
  jobId: string;
  workerId: string;
  coverLetter?: string | null;
  proposedRate?: number | null;
  status: ApplicationStatus;
  createdAt: string;
  updatedAt: string;
  job?: { id: string; title: string; postedById: string };
  worker?: { id: string; name: string; avatar?: string | null; email?: string | null; category?: Category };
}

export interface JobMessage {
  id: string;
  jobId: string;
  body: string;
  readAt?: string | null;
  createdAt: string;
  sender: { id: string; firstName: string; lastName: string; avatar?: string | null };
  recipient: { id: string; firstName: string; lastName: string; avatar?: string | null };
}

// ── Notifications ───────────────────────────────────────────────────────────

export type NotificationType = "tip" | "review" | "contact" | "system" | "message";

export interface AppNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message?: string | null;
  href?: string | null;
  read: boolean;
  createdAt: string;
}

// ── Conversations ───────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  subject?: string | null;
  createdAt: string;
  updatedAt: string;
  participants: ConversationParticipant[];
  messages?: Message[];
  unreadCount?: number;
}

export interface ConversationParticipant {
  id: string;
  conversationId: string;
  userId: string;
  lastReadAt?: string | null;
  joinedAt: string;
  user: { id: string; firstName: string; lastName: string; avatar?: string | null };
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  attachmentUrl?: string | null;
  attachmentType?: string | null;
  readAt?: string | null;
  createdAt: string;
  sender: { id: string; firstName: string; lastName: string; avatar?: string | null };
}
