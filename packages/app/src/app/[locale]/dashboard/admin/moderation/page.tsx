"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Search, Star, Loader2 } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/useToast";
import { formatDate } from "@/lib/utils";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api";
const TOKEN_KEY = "bc_token";

interface ModerationReview {
  id: string;
  rating: number;
  comment?: string | null;
  body?: string | null;
  flagged: boolean;
  flagReason?: string | null;
  status: string;
  createdAt: string;
  worker: { id: string; name: string };
  author: { id: string; firstName: string; lastName: string };
}

function authHeaders() {
  const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function AdminModerationPage() {
  const { user } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [reviews, setReviews] = useState<ModerationReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/v1/reviews/moderation/queue`, { headers: authHeaders() });
      if (!res.ok) throw new Error();
      const json = await res.json();
      setReviews(json.data);
    } catch {
      toast("Failed to load moderation queue", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user && user.role !== "admin") {
      router.push("/");
      return;
    }
    fetchQueue();
  }, [user, router, fetchQueue]);

  const handleModerate = async (reviewId: string, action: "approve" | "reject") => {
    setActionLoading(reviewId);
    try {
      const res = await fetch(`${API}/v1/reviews/${reviewId}/moderate`, {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error();
      toast(`Review ${action}d`, "success");
      setReviews((prev) => prev.filter((r) => r.id !== reviewId));
    } catch {
      toast("Failed to moderate review", "error");
    } finally {
      setActionLoading(null);
    }
  };

  if (!user || user.role !== "admin") return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex items-center gap-3 mb-8">
        <Link
          href="/dashboard/admin"
          className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Moderation Queue</h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      ) : reviews.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-gray-400">
          <Search size={40} className="opacity-30" />
          <p className="text-sm">No reviews pending moderation</p>
        </div>
      ) : (
        <div className="space-y-4">
          {reviews.map((review) => (
            <div key={review.id} className="rounded-xl border bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{review.author.firstName} {review.author.lastName}</span>
                    <span className="text-xs text-gray-400">reviewed</span>
                    <span className="font-medium text-gray-900 dark:text-gray-100">{review.worker.name}</span>
                  </div>
                  <div className="flex items-center gap-1 mb-1">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <Star key={s} size={12} className={s <= review.rating ? "text-yellow-400" : "text-gray-200"} fill={s <= review.rating ? "currentColor" : "none"} />
                    ))}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">{review.comment ?? review.body}</p>
                  {review.flagged && review.flagReason && (
                    <p className="mt-1 text-xs text-red-500">Flagged: {review.flagReason}</p>
                  )}
                  <p className="mt-1 text-xs text-gray-400">{formatDate(new Date(review.createdAt))}</p>
                </div>
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => handleModerate(review.id, "approve")}
                    disabled={actionLoading === review.id}
                    className="rounded-lg bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                  >
                    {actionLoading === review.id ? <Loader2 size={14} className="animate-spin" /> : "Approve"}
                  </button>
                  <button
                    onClick={() => handleModerate(review.id, "reject")}
                    disabled={actionLoading === review.id}
                    className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
