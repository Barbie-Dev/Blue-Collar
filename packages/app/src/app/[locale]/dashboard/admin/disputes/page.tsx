"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Scale, Loader2 } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/useToast";
import { formatDate } from "@/lib/utils";
import LoadingState from "@/components/LoadingState";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api";
const TOKEN_KEY = "bc_token";

interface Dispute {
  id: string;
  workerId: string;
  filedById: string;
  reason: string;
  evidence?: string | null;
  status: string;
  resolution?: string | null;
  resolvedById?: string | null;
  createdAt: string;
  worker: { id: string; name: string };
  filedBy: { id: string; firstName: string; lastName: string };
}

const STATUS_COLORS: Record<string, string> = {
  open: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  under_review: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  resolved: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  dismissed: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function AdminDisputesPage() {
  const { user } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState<{ page: number; pages: number } | null>(null);

  const fetchDisputes = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/v1/disputes?page=${p}&limit=20`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error();
      const json = await res.json();
      setDisputes(json.data);
      setMeta(json.meta ?? null);
    } catch {
      toast("Failed to load disputes", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user && user.role !== "admin") {
      router.push("/");
      return;
    }
    fetchDisputes(page);
  }, [user, router, page, fetchDisputes]);

  const handleResolve = async (id: string, status: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`${API}/v1/disputes/${id}/resolve`, {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ status, resolution: `Resolved by admin as ${status}` }),
      });
      if (!res.ok) throw new Error();
      toast(`Dispute ${status === "resolved" ? "resolved" : status === "dismissed" ? "dismissed" : "moved to review"}`, "success");
      fetchDisputes(page);
    } catch {
      toast("Failed to update dispute", "error");
    } finally {
      setActionLoading(null);
    }
  };

  if (!user || user.role !== "admin") return null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex items-center gap-3 mb-8">
        <Link
          href="/dashboard/admin"
          className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dispute Review</h1>
      </div>

      {loading ? (
        <LoadingState className="py-12" />
      ) : disputes.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-gray-400">
          <Scale size={40} className="opacity-30" />
          <p className="text-sm">No disputes found</p>
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {disputes.map((d) => (
              <div key={d.id} className="rounded-xl border bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="font-semibold text-gray-900 dark:text-gray-100">
                        Dispute against {d.worker.name}
                      </h3>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[d.status] ?? ""}`}>
                        {d.status.replace("_", " ")}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
                      <span className="font-medium">Filed by:</span> {d.filedBy.firstName} {d.filedBy.lastName}
                    </p>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      <span className="font-medium">Reason:</span> {d.reason}
                    </p>
                    {d.evidence && (
                      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        <span className="font-medium">Evidence:</span> {d.evidence}
                      </p>
                    )}
                    {d.resolution && (
                      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        <span className="font-medium">Resolution:</span> {d.resolution}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-gray-400">{formatDate(new Date(d.createdAt))}</p>
                  </div>
                  {d.status !== "resolved" && d.status !== "dismissed" && (
                    <div className="flex flex-col gap-1">
                      <button
                        onClick={() => handleResolve(d.id, "resolved")}
                        disabled={actionLoading === d.id}
                        className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                      >
                        {actionLoading === d.id ? <Loader2 size={12} className="animate-spin" /> : "Resolve"}
                      </button>
                      <button
                        onClick={() => handleResolve(d.id, "dismissed")}
                        disabled={actionLoading === d.id}
                        className="rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
                      >
                        Dismiss
                      </button>
                      <button
                        onClick={() => handleResolve(d.id, "under_review")}
                        disabled={actionLoading === d.id}
                        className="rounded-lg border px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:border-gray-700 dark:text-blue-400 dark:hover:bg-blue-950 disabled:opacity-50 transition-colors"
                      >
                        Review
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {meta && meta.pages > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
              <span>Page {page} of {meta.pages}</span>
              <div className="flex gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                  className="rounded border px-3 py-1 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  disabled={page >= meta.pages}
                  onClick={() => setPage(page + 1)}
                  className="rounded border px-3 py-1 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
