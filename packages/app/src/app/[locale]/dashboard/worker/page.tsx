"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Download, Eye, Loader2, Star, TrendingUp, Wallet } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { DashboardTableSkeleton } from "@/components/Skeleton";
import { cn } from "@/lib/utils";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api";

type DatePreset = "7" | "30" | "90" | "custom";

type DashboardWorker = {
  id: string;
  name: string;
  isActive: boolean;
  category: { id: string; name: string };
};

type SeriesPoint = {
  date: string;
  views: number;
  uniqueViews: number;
  tips: number;
  tipCount: number;
  avgRating: number | null;
  reviewCount: number;
  earnings: number;
};

type PersonalAnalytics = {
  worker: { id: string; name: string; category: string; walletAddress?: string | null };
  range: { startDate: string; endDate: string };
  summary: {
    totalViews: number;
    uniqueViews: number;
    tipsReceived: number;
    tipCount: number;
    avgRating: number;
    reviewCount: number;
    earnings: number;
    contacts: number;
  };
  deltas: {
    totalViews: number;
    uniqueViews: number;
    tipsReceived: number;
    avgRating: number;
    earnings: number;
  };
  charts: {
    series: SeriesPoint[];
    ratingDistribution: Array<{ rating: number; count: number }>;
  };
};

function dateDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateLabel(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatXlm(value: number) {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM`;
}

export default function WorkerPersonalDashboardPage() {
  const { user, token, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [workers, setWorkers] = useState<DashboardWorker[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState("");
  const [preset, setPreset] = useState<DatePreset>("30");
  const [startDate, setStartDate] = useState(dateDaysAgo(30));
  const [endDate, setEndDate] = useState(today());
  const [data, setData] = useState<PersonalAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && (!user || (user.role !== "curator" && user.role !== "admin"))) {
      router.replace("/auth/login");
    }
  }, [user, authLoading, router]);

  const rangeParams = useMemo(() => {
    const params = new URLSearchParams({ startDate, endDate });
    return params.toString();
  }, [startDate, endDate]);

  const loadWorkers = useCallback(async () => {
    if (!token) return;
    const res = await fetch(`${API}/workers/mine?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Failed to load your workers");
    const json = await res.json();
    const rows = json.data ?? [];
    setWorkers(rows);
    if (!selectedWorkerId && rows[0]?.id) setSelectedWorkerId(rows[0].id);
  }, [token, selectedWorkerId]);

  const loadAnalytics = useCallback(async () => {
    if (!token || !selectedWorkerId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/workers/${selectedWorkerId}/analytics/dashboard?${rangeParams}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.message ?? "Failed to load worker analytics");
      }
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load worker analytics");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token, selectedWorkerId, rangeParams]);

  useEffect(() => {
    if (!authLoading && token) {
      loadWorkers().catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load your workers");
        setLoading(false);
      });
    }
  }, [authLoading, token, loadWorkers]);

  useEffect(() => {
    if (selectedWorkerId) loadAnalytics();
  }, [selectedWorkerId, loadAnalytics]);

  const applyPreset = (nextPreset: DatePreset) => {
    setPreset(nextPreset);
    if (nextPreset !== "custom") {
      const days = Number(nextPreset);
      setStartDate(dateDaysAgo(days));
      setEndDate(today());
    }
  };

  const exportCsv = () => {
    if (!selectedWorkerId || !token) return;
    window.open(`${API}/workers/${selectedWorkerId}/analytics/export?${rangeParams}`, "_blank");
  };

  if (authLoading || (!user && !authLoading)) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <DashboardTableSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Worker Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Personal profile views, tips, ratings, and earnings over time.
          </p>
        </div>
        <button
          onClick={exportCsv}
          disabled={!data}
          className="inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <Download size={16} /> Export CSV
        </button>
      </div>

      <div className="mb-6 rounded-xl border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
              Worker
              <select
                value={selectedWorkerId}
                onChange={(event) => setSelectedWorkerId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              >
                {workers.map((worker) => (
                  <option key={worker.id} value={worker.id}>{worker.name}</option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
              Start date
              <input
                type="date"
                value={startDate}
                onChange={(event) => { setPreset("custom"); setStartDate(event.target.value); }}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
            </label>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
              End date
              <input
                type="date"
                value={endDate}
                onChange={(event) => { setPreset("custom"); setEndDate(event.target.value); }}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
            </label>
          </div>
          <div className="flex rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
            {(["7", "30", "90", "custom"] as DatePreset[]).map((item) => (
              <button
                key={item}
                onClick={() => applyPreset(item)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  preset === item ? "bg-white text-gray-900 shadow-sm dark:bg-gray-950 dark:text-gray-100" : "text-gray-500 hover:text-gray-700 dark:text-gray-400"
                )}
              >
                {item === "custom" ? "Custom" : `${item}D`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      {workers.length === 0 && !loading ? (
        <div className="rounded-xl border bg-white py-16 text-center text-gray-500 dark:border-gray-700 dark:bg-gray-900">
          Create a worker profile to start collecting dashboard metrics.
        </div>
      ) : loading ? (
        <DashboardTableSkeleton />
      ) : data ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard icon={<Eye size={18} />} label="Profile views" value={data.summary.totalViews.toLocaleString()} delta={data.deltas.totalViews} />
            <MetricCard icon={<TrendingUp size={18} />} label="Unique views" value={data.summary.uniqueViews.toLocaleString()} delta={data.deltas.uniqueViews} />
            <MetricCard icon={<Wallet size={18} />} label="Tips received" value={formatXlm(data.summary.tipsReceived)} delta={data.deltas.tipsReceived} sub={`${data.summary.tipCount} tips`} />
            <MetricCard icon={<Star size={18} />} label="Avg rating" value={data.summary.avgRating ? data.summary.avgRating.toFixed(1) : "—"} delta={data.deltas.avgRating} sub={`${data.summary.reviewCount} reviews`} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard title="Views over time">
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={data.charts.series}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={12} />
                  <YAxis fontSize={12} />
                  <Tooltip labelFormatter={(value) => new Date(String(value)).toLocaleDateString()} />
                  <Area type="monotone" dataKey="views" name="Views" stroke="#2563eb" fill="#dbeafe" />
                  <Area type="monotone" dataKey="uniqueViews" name="Unique views" stroke="#0891b2" fill="#cffafe" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Tips and earnings">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={data.charts.series}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={12} />
                  <YAxis fontSize={12} />
                  <Tooltip labelFormatter={(value) => new Date(String(value)).toLocaleDateString()} />
                  <Bar dataKey="earnings" name="Earnings (XLM)" fill="#16a34a" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Ratings trend">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={data.charts.series}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={12} />
                  <YAxis domain={[0, 5]} fontSize={12} />
                  <Tooltip labelFormatter={(value) => new Date(String(value)).toLocaleDateString()} />
                  <Line type="monotone" dataKey="avgRating" name="Average rating" stroke="#f59e0b" strokeWidth={2} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Rating distribution">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={data.charts.ratingDistribution} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" allowDecimals={false} fontSize={12} />
                  <YAxis type="category" dataKey="rating" tickFormatter={(rating) => `${rating}★`} fontSize={12} />
                  <Tooltip />
                  <Bar dataKey="count" name="Reviews" fill="#f59e0b" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-xl border bg-white py-16 dark:border-gray-700 dark:bg-gray-900">
          <Loader2 size={24} className="animate-spin text-gray-400" />
        </div>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, delta, sub }: { icon: React.ReactNode; label: string; value: string; delta: number; sub?: string }) {
  const isPositive = delta > 0;
  const isNegative = delta < 0;
  return (
    <div className="rounded-xl border bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex items-center gap-2 text-gray-400">
        {icon}<span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      <p className={cn("mt-1 text-xs", isPositive ? "text-green-600" : isNegative ? "text-red-600" : "text-gray-400")}>
        {delta > 0 ? "+" : ""}{delta}{label === "Avg rating" ? "" : "%"} vs previous period{sub ? ` · ${sub}` : ""}
      </p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {children}
    </div>
  );
}
