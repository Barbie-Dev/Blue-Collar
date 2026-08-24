"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Settings, BarChart3 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useWallet } from "@/hooks/useWallet";
import { cn } from "@/lib/utils";
import FriendbotBanner from "@/components/FriendbotBanner";
import { DashboardTableSkeleton } from "@/components/Skeleton";
import {
  WorkersPanel,
  AnalyticsPanel,
  DeleteWorkerDialog,
  type DashboardWorker,
} from "@/components/Dashboard";
import type { CuratorAnalytics, ViewTrend } from "@/types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api";
const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
const IS_STELLAR_TESTNET =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK?.toLowerCase() === "testnet";

export default function DashboardPage() {
  const { user, token, isLoading: authLoading } = useAuth();
  const { publicKey } = useWallet();
  const router = useRouter();

  // ── Workers state ────────────────────────────────────────────────────────
  const [workers, setWorkers] = useState<DashboardWorker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Wallet balance ───────────────────────────────────────────────────────
  const [xlmBalance, setXlmBalance] = useState<number | null>(null);

  // ── Analytics state ──────────────────────────────────────────────────────
  const [analytics, setAnalytics] = useState<CuratorAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);

  // ── Per-worker view trends ───────────────────────────────────────────────
  const [selectedWorkerTrends, setSelectedWorkerTrends] = useState<ViewTrend[] | null>(null);
  const [selectedWorkerName, setSelectedWorkerName] = useState<string>("");
  const [trendsLoading, setTrendsLoading] = useState(false);

  // ── Tab + delete state ───────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<"workers" | "analytics">("workers");
  const [deleteTarget, setDeleteTarget] = useState<DashboardWorker | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Auth guard ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (
      !authLoading &&
      (!user || (user.role !== "curator" && user.role !== "admin"))
    ) {
      router.replace("/auth/login");
    }
  }, [user, authLoading, router]);

  // ── Data fetching ────────────────────────────────────────────────────────
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
      // Analytics is supplementary — don't block the page on failure.
    } finally {
      setAnalyticsLoading(false);
    }
  }, [token]);

  const fetchWorkerTrends = async (workerId: string, workerName: string) => {
    if (!token) return;
    setTrendsLoading(true);
    setSelectedWorkerName(workerName);
    try {
      const res = await fetch(
        `${API}/workers/${workerId}/analytics/trends?days=30`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
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

  // ── Wallet balance polling ───────────────────────────────────────────────
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
          (b: { asset_type: string }) => b.asset_type === "native"
        );
        setXlmBalance(nativeBalance ? Number(nativeBalance.balance) : 0);
      })
      .catch(() => setXlmBalance(null));
  }, [publicKey]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  /** Optimistic toggle of a worker's active state. */
  const handleToggle = async (worker: DashboardWorker) => {
    setWorkers((prev) =>
      prev.map((w) => (w.id === worker.id ? { ...w, isActive: !w.isActive } : w))
    );
    try {
      const res = await fetch(`${API}/workers/${worker.id}/toggle`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Toggle failed");
    } catch {
      // Roll back on failure.
      setWorkers((prev) =>
        prev.map((w) => (w.id === worker.id ? { ...w, isActive: worker.isActive } : w))
      );
    }
  };

  /** Optimistic delete — removes immediately, restores on failure. */
  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);

    setWorkers((prev) => prev.filter((w) => w.id !== target.id));
    setDeleteTarget(null);

    try {
      const res = await fetch(`${API}/workers/${target.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Delete failed");
    } catch {
      setWorkers((prev) => [target, ...prev]);
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

      {/* Error banner */}
      {error && (
        <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* Tab panels */}
      {activeTab === "workers" && (
        <WorkersPanel
          workers={workers}
          loading={loading}
          selectedWorkerTrends={selectedWorkerTrends}
          selectedWorkerName={selectedWorkerName}
          trendsLoading={trendsLoading}
          onToggle={handleToggle}
          onDeleteRequest={setDeleteTarget}
          onViewTrends={fetchWorkerTrends}
          onCloseTrends={() => setSelectedWorkerTrends(null)}
        />
      )}

      {activeTab === "analytics" && (
        <AnalyticsPanel
          analytics={analytics}
          loading={analyticsLoading}
          onExportCsv={handleExportCsv}
        />
      )}

      {/* Delete confirmation dialog */}
      <DeleteWorkerDialog
        workerName={deleteTarget?.name}
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        onConfirm={handleDelete}
        isDeleting={deleting}
      />
    </div>
  );
}
