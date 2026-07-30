"use client";

import { useEffect, useState, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Plus,
  Pencil,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Loader2,
  X,
  AlertTriangle,
  Settings,
  Eye,
  Heart,
  Star,
  MessageSquare,
  TrendingUp,
  Download,
  BarChart3,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useWallet } from "@/hooks/useWallet";
import { cn } from "@/lib/utils";
import FriendbotBanner from "@/components/FriendbotBanner";
import { DashboardTableSkeleton } from "@/components/Skeleton";
import type { CuratorAnalytics, ViewTrend } from "@/types";

// ── Dynamic imports (code splitting: recharts is ~200KB) ─────────────────────
const CuratorCharts = dynamic(
  () => import("@/components/charts/CuratorCharts"),
  { ssr: false, loading: () => <div className="h-[250px] rounded-lg bg-gray-50 animate-pulse" /> }
);

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api";
const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
const IS_STELLAR_TESTNET = process.env.NEXT_PUBLIC_STELLAR_NETWORK?.toLowerCase() === "testnet";

interface DashboardWorker {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  category: { id: string; name: string };
}

export default function DashboardPage() {
  const { user, token, isLoading: authLoading } = useAuth();
  const { publicKey } = useWallet();
  const router = useRouter();

  const [workers, setWorkers] = useState<DashboardWorker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [xlmBalance, setXlmBalance] = useState<number | null>(null);

  // Analytics state
  const [analytics, setAnalytics] = useState<CuratorAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [selectedWorkerTrends, setSelectedWorkerTrends] = useState<ViewTrend[] | null>(null);
  const [selectedWorkerName, setSelectedWorkerName] = useState<string>("");
  const [trendsLoading, setTrendsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"workers" | "analytics">("workers");

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<DashboardWorker | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!authLoading && (!user || (user.role !== "curator" && user.role !== "admin"))) {
      router.replace("/auth/login");
    }
  }, [user, authLoading, router]);

  const fetchWorkers = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/workers/mine`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load workers");
      const json = await res.json();
      setWorkers(json.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const fetchAnalytics = useCallback(async () => {
    if (!token) return;
    setAnalyticsLoading(true);
    try {
      const res = await fetch(`${API}/analytics/curator`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load analytics");
      const json = await res.json();
      setAnalytics(json.data);
    } catch {
      // analytics is supplementary — don't block the page
    } finally {
      setAnalyticsLoading(false);
    }
  }, [token]);

  const fetchWorkerTrends = async (workerId: string, workerName: string) => {
    if (!token) return;
    setTrendsLoading(true);
    setSelectedWorkerName(workerName);
    try {
      const res = await fetch(`${API}/workers/${workerId}/analytics/trends?days=30`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load trends");
      const json = await res.json();
      setSelectedWorkerTrends(json.data);
    } catch {
      setSelectedWorkerTrends(null);
    } finally {
      setTrendsLoading(false);
    }
  };

  useEffect(() => {
    if (!authLoading && token) {
      fetchWorkers();
      fetchAnalytics();
    }
  }, [authLoading, token, fetchWorkers, fetchAnalytics]);

  useEffect(() => {
    if (!IS_STELLAR_TESTNET || !publicKey) {
      setXlmBalance(null);
      return;
    }

    fetch(`${HORIZON_TESTNET}/accounts/${publicKey}`)
      .then((res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("Failed to load wallet balance");
        return res.json();
      })
      .then((account) => {
        const nativeBalance = account?.balances?.find(
          (balance: { asset_type: string }) => balance.asset_type === "native"
        );
        setXlmBalance(nativeBalance ? Number(nativeBalance.balance) : 0);
      })
      .catch(() => setXlmBalance(null));
  }, [publicKey]);

  // ── Toggle active/inactive (optimistic) ──────────────────────────────────
  const handleToggle = async (worker: DashboardWorker) => {
    setWorkers((prev: DashboardWorker[]) =>
      prev.map((w: DashboardWorker) => (w.id === worker.id ? { ...w, isActive: !w.isActive } : w))
    );
    try {
      const res = await fetch(`${API}/workers/${worker.id}/toggle`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Toggle failed");
    } catch {
      setWorkers((prev: DashboardWorker[]) =>
        prev.map((w: DashboardWorker) => (w.id === worker.id ? { ...w, isActive: worker.isActive } : w))
      );
    }
  };

  // ── Delete (optimistic) ───────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);

    setWorkers((prev: DashboardWorker[]) => prev.filter((w: DashboardWorker) => w.id !== target.id));
    setDeleteTarget(null);

    try {
      const res = await fetch(`${API}/workers/${target.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Delete failed");
    } catch {
      setWorkers((prev: DashboardWorker[]) => [target, ...prev]);
    } finally {
      setDeleting(false);
    }
  };

  const handleExportCsv = () => {
    if (!token) return;
    const link = document.createElement("a");
    link.href = `${API}/analytics/export/curator`;
    link.setAttribute("download", "worker-analytics.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ── Loading / auth guard ──────────────────────────────────────────────────
  if (authLoading || (!user && !authLoading)) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <DashboardTableSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      {publicKey && xlmBalance !== null && (
        <FriendbotBanner walletAddress={publicKey} xlmBalance={xlmBalance} />
      )}

      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Workers</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Manage your worker listings and track performance
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/workers/new"
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus size={16} />
            Create New Worker
          </Link>
          <Link
            href="/dashboard/settings"
            className="flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            title="Settings"
          >
            <Settings size={16} />
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-1 rounded-lg bg-gray-100 p-1">
        <button
          onClick={() => setActiveTab("workers")}
          className={cn(
            "flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors",
            activeTab === "workers"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          )}
        >
          Workers
        </button>
        <button
          onClick={() => setActiveTab("analytics")}
          className={cn(
            "flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors",
            activeTab === "analytics"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          )}
        >
          <span className="flex items-center justify-center gap-1.5">
            <BarChart3 size={14} />
            Analytics
          </span>
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {activeTab === "workers" && (
        <>
          {/* Workers Table */}
          <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
            {loading ? (
              <DashboardTableSkeleton />
            ) : workers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p className="text-gray-500 font-medium">No workers yet</p>
                <p className="mt-1 text-sm text-gray-400">
                  Create your first worker listing to get started.
                </p>
                <Link
                  href="/dashboard/workers/new"
                  className="mt-4 flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                >
                  <Plus size={15} />
                  Create Worker
                </Link>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <th className="px-5 py-3.5">Name</th>
                    <th className="px-5 py-3.5">Category</th>
                    <th className="px-5 py-3.5">Status</th>
                    <th className="px-5 py-3.5">Created</th>
                    <th className="px-5 py-3.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {workers.map((worker: DashboardWorker) => (
                    <tr key={worker.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-4 font-medium text-gray-800">
                        {worker.name}
                      </td>
                      <td className="px-5 py-4 text-gray-500">
                        <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-600">
                          {worker.category.name}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-0.5 text-xs font-medium",
                            worker.isActive
                              ? "bg-green-50 text-green-600"
                              : "bg-gray-100 text-gray-500"
                          )}
                        >
                          {worker.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-gray-400">
                        {new Date(worker.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => fetchWorkerTrends(worker.id, worker.name)}
                            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-blue-600 transition-colors"
                            title="View Trends"
                          >
                            <TrendingUp size={15} />
                          </button>
                          <Link
                            href={`/dashboard/workers/${worker.id}/edit`}
                            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-blue-600 transition-colors"
                            title="Edit"
                          >
                            <Pencil size={15} />
                          </Link>
                          <button
                            onClick={() => handleToggle(worker)}
                            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-blue-600 transition-colors"
                            title={worker.isActive ? "Deactivate" : "Activate"}
                          >
                            {worker.isActive ? (
                              <ToggleRight size={17} className="text-green-500" />
                            ) : (
                              <ToggleLeft size={17} />
                            )}
                          </button>
                          <button
                            onClick={() => setDeleteTarget(worker)}
                            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-500 transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* View Trends Panel */}
          {selectedWorkerTrends && (
            <div className="mt-6 rounded-xl border bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  Views — {selectedWorkerName} (Last 30 days)
                </h3>
                <button
                  onClick={() => setSelectedWorkerTrends(null)}
                  className="rounded-md p-1 text-gray-400 hover:text-gray-600"
                >
                  <X size={16} />
                </button>
              </div>
              <CuratorCharts.ViewTrendsChart
                trends={selectedWorkerTrends}
                trendsLoading={trendsLoading}
                workerName={selectedWorkerName}
              />
            </div>
          )}
        </>
      )}

      {activeTab === "analytics" && (
        <div className="space-y-6">
          {analyticsLoading ? (
            <DashboardTableSkeleton />
          ) : analytics ? (
            <>
              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <MetricCard
                  icon={<Eye size={18} />}
                  label="Total Views"
                  value={analytics.totals.views}
                  sub={`${analytics.totals.viewsThisMonth} this month`}
                />
                <MetricCard
                  icon={<Heart size={18} />}
                  label="Bookmarks"
                  value={analytics.totals.bookmarks}
                />
                <MetricCard
                  icon={<Star size={18} />}
                  label="Avg Rating"
                  value={analytics.totals.avgRating?.toFixed(1) ?? "—"}
                  sub={`${analytics.totals.reviewCount ?? 0} reviews`}
                />
                <MetricCard
                  icon={<MessageSquare size={18} />}
                  label="Contacts"
                  value={analytics.totals.contacts}
                  sub={`${analytics.totals.contactsThisMonth} this month`}
                />
              </div>

              {/* Revenue */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-xl border bg-white p-6 shadow-sm">
                  <p className="text-sm font-medium text-gray-500">Total Tips Received</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900">
                    {analytics.totals.tips.toLocaleString()} XLM
                  </p>
                  <p className="mt-0.5 text-xs text-gray-400">
                    {analytics.totals.tipCount} transactions
                  </p>
                </div>
                <div className="rounded-xl border bg-white p-6 shadow-sm">
                  <p className="text-sm font-medium text-gray-500">Workers Overview</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900">
                    {analytics.activeWorkers}{" "}
                    <span className="text-base font-normal text-gray-400">
                      / {analytics.totalWorkers} active
                    </span>
                  </p>
                </div>
              </div>

              {/* Per-Worker Breakdown */}
              <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b">
                  <h3 className="font-semibold text-gray-900">Worker Performance</h3>
                  <button
                    onClick={handleExportCsv}
                    className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <Download size={13} />
                    Export CSV
                  </button>
                </div>
                {analytics.workers.length === 0 ? (
                  <div className="py-12 text-center text-sm text-gray-400">
                    No worker data yet
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          <th className="px-5 py-3">Worker</th>
                          <th className="px-5 py-3">Category</th>
                          <th className="px-5 py-3 text-right">Views</th>
                          <th className="px-5 py-3 text-right">Bookmarks</th>
                          <th className="px-5 py-3 text-right">Tips</th>
                          <th className="px-5 py-3 text-right">Contacts</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {analytics.workers.map((w) => (
                          <tr key={w.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-5 py-3.5 font-medium text-gray-800">
                              <div className="flex items-center gap-2">
                                {w.name}
                                {!w.isActive && (
                                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
                                    Inactive
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-5 py-3.5 text-gray-500">{w.category}</td>
                            <td className="px-5 py-3.5 text-right tabular-nums text-gray-700">{w.views.toLocaleString()}</td>
                            <td className="px-5 py-3.5 text-right tabular-nums text-gray-700">{w.bookmarks}</td>
                            <td className="px-5 py-3.5 text-right tabular-nums text-gray-700">{w.tips.toLocaleString()}</td>
                            <td className="px-5 py-3.5 text-right tabular-nums text-gray-700">{w.contacts}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Worker Views Bar Chart */}
              {analytics.workers.length > 0 && (
                <div className="rounded-xl border bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Views by Worker</h3>
                  <CuratorCharts.WorkersBarChart workers={analytics.workers} />
                </div>
              )}
            </>
          ) : (
            <div className="rounded-xl border bg-white py-16 text-center">
              <p className="text-gray-500">Unable to load analytics</p>
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog.Root
        open={!!deleteTarget}
        onOpenChange={(open: boolean) => { if (!open) setDeleteTarget(null); }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50">
                  <AlertTriangle size={18} className="text-red-500" />
                </div>
                <div>
                  <Dialog.Title className="font-semibold text-gray-900">
                    Delete worker?
                  </Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-sm text-gray-500">
                    This will permanently remove{" "}
                    <span className="font-medium text-gray-700">
                      {deleteTarget?.name}
                    </span>
                    . This action cannot be undone.
                  </Dialog.Description>
                </div>
              </div>
              <Dialog.Close className="rounded-md p-1 text-gray-400 hover:text-gray-600">
                <X size={16} />
              </Dialog.Close>
            </div>

            <div className="mt-5 flex gap-3">
              <Dialog.Close className="flex-1 rounded-lg border py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                Cancel
              </Dialog.Close>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60 transition-colors"
              >
                {deleting && <Loader2 size={14} className="animate-spin" />}
                Delete
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2 text-gray-400 mb-2">{icon}<span className="text-xs font-medium uppercase tracking-wide">{label}</span></div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}
