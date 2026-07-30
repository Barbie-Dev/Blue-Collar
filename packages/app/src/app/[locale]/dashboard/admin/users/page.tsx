"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Shield, ShieldOff, Ban, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/useToast";
import { useDebounce } from "@/hooks/useDebounce";
import { suspendUser, unsuspendUser, banUser, changeUserRole, bulkSuspendUsers, bulkUnsuspendUsers } from "@/lib/api";
import { formatDate } from "@/lib/utils";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api";
const TOKEN_KEY = "bc_token";

type Role = "user" | "curator" | "admin";

interface AdminUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  deletedAt?: string | null;
  verified?: boolean;
  createdAt: string;
}

function authHeaders() {
  const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function AdminUsersPage() {
  const { user } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState<{ page: number; pages: number } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [roleFilter, setRoleFilter] = useState<"" | Role>("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "suspended">("");

  const fetchUsers = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), limit: "20" });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (roleFilter) params.set("role", roleFilter);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`${API}/v1/admin/users?${params.toString()}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error();
      const json = await res.json();
      setUsers(json.data);
      setMeta(json.meta ?? null);
      setSelected(new Set());
    } catch {
      toast("Failed to load users", "error");
    } finally {
      setLoading(false);
    }
  }, [toast, debouncedSearch, roleFilter, statusFilter]);

  useEffect(() => {
    if (user && user.role !== "admin") {
      router.push("/");
      return;
    }
    fetchUsers(page);
  }, [user, router, page, fetchUsers]);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, roleFilter, statusFilter]);

  const handleSuspend = async (userId: string) => {
    setActionLoading(userId);
    try {
      await suspendUser(userId);
      toast("User suspended", "success");
      fetchUsers(page);
    } catch {
      toast("Failed to suspend user", "error");
    } finally {
      setActionLoading(null);
    }
  };

  const handleUnsuspend = async (userId: string) => {
    setActionLoading(userId);
    try {
      await unsuspendUser(userId);
      toast("User unsuspended", "success");
      fetchUsers(page);
    } catch {
      toast("Failed to unsuspend user", "error");
    } finally {
      setActionLoading(null);
    }
  };

  const handleBan = async (userId: string) => {
    if (!confirm("Are you sure you want to permanently ban this user? This will delete their account.")) return;
    setActionLoading(userId);
    try {
      await banUser(userId);
      toast("User banned", "success");
      fetchUsers(page);
    } catch {
      toast("Failed to ban user", "error");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRoleChange = async (userId: string, role: Role) => {
    setActionLoading(userId);
    try {
      await changeUserRole(userId, role);
      toast("Role updated", "success");
      fetchUsers(page);
    } catch {
      toast("Failed to update role", "error");
    } finally {
      setActionLoading(null);
    }
  };

  const toggleSelected = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const selectableUsers = useMemo(() => users.filter((u) => u.role !== "admin"), [users]);
  const allSelectableSelected = selectableUsers.length > 0 && selectableUsers.every((u) => selected.has(u.id));

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allSelectableSelected) return new Set();
      return new Set(selectableUsers.map((u) => u.id));
    });
  };

  const handleBulkSuspend = async () => {
    if (selected.size === 0) return;
    setBulkLoading(true);
    try {
      await bulkSuspendUsers(Array.from(selected));
      toast(`Suspended ${selected.size} user(s)`, "success");
      fetchUsers(page);
    } catch {
      toast("Failed to bulk suspend users", "error");
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkUnsuspend = async () => {
    if (selected.size === 0) return;
    setBulkLoading(true);
    try {
      await bulkUnsuspendUsers(Array.from(selected));
      toast(`Unsuspended ${selected.size} user(s)`, "success");
      fetchUsers(page);
    } catch {
      toast("Failed to bulk unsuspend users", "error");
    } finally {
      setBulkLoading(false);
    }
  };

  const isSuspended = (u: AdminUser) => u.deletedAt != null;

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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">User Management</h1>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email..."
          aria-label="Search users"
          className="min-w-55 flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as "" | Role)}
          aria-label="Filter by role"
          className="rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="">All roles</option>
          <option value="user">User</option>
          <option value="curator">Curator</option>
          <option value="admin">Admin</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "suspended")}
          aria-label="Filter by status"
          className="rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>

      {selected.size > 0 && (
        <div className="mb-4 flex items-center justify-between rounded-lg border bg-blue-50 px-4 py-2.5 text-sm dark:border-blue-900 dark:bg-blue-950">
          <span className="font-medium text-blue-900 dark:text-blue-300">{selected.size} selected</span>
          <div className="flex gap-2">
            <button
              onClick={handleBulkSuspend}
              disabled={bulkLoading}
              className="rounded px-3 py-1 text-xs font-medium text-yellow-700 hover:bg-yellow-100 disabled:opacity-50 dark:text-yellow-400 dark:hover:bg-yellow-950"
            >
              Suspend selected
            </button>
            <button
              onClick={handleBulkUnsuspend}
              disabled={bulkLoading}
              className="rounded px-3 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50 dark:text-green-400 dark:hover:bg-green-950"
            >
              Unsuspend selected
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      ) : users.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-gray-400">
          <p className="text-sm">No users match your filters</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border dark:border-gray-800">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50 text-left text-xs font-medium uppercase text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all users"
                      checked={allSelectableSelected}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Joined</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-800">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${u.firstName} ${u.lastName}`}
                        checked={selected.has(u.id)}
                        disabled={u.role === "admin"}
                        onChange={() => toggleSelected(u.id)}
                      />
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                      {u.firstName} {u.lastName}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{u.email}</td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        disabled={actionLoading === u.id || u.role === "admin"}
                        onChange={(e) => handleRoleChange(u.id, e.target.value as Role)}
                        aria-label={`Change role for ${u.firstName} ${u.lastName}`}
                        className={`rounded px-2 py-0.5 text-xs font-medium disabled:opacity-60 ${
                          u.role === "admin" ? "bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400" :
                          u.role === "curator" ? "bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400" :
                          "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                        }`}
                      >
                        <option value="user">user</option>
                        <option value="curator">curator</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      {isSuspended(u) ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                          <ShieldOff size={12} />
                          Suspended
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          <Shield size={12} />
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400 dark:text-gray-500">
                      {formatDate(new Date(u.createdAt))}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {isSuspended(u) ? (
                          <button
                            onClick={() => handleUnsuspend(u.id)}
                            disabled={actionLoading === u.id}
                            className="rounded px-2 py-1 text-xs font-medium text-green-600 hover:bg-green-50 dark:hover:bg-green-950 disabled:opacity-50 transition-colors"
                          >
                            Unsuspend
                          </button>
                        ) : (
                          <button
                            onClick={() => handleSuspend(u.id)}
                            disabled={actionLoading === u.id}
                            className="rounded px-2 py-1 text-xs font-medium text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-950 disabled:opacity-50 transition-colors"
                          >
                            Suspend
                          </button>
                        )}
                        <button
                          onClick={() => handleBan(u.id)}
                          disabled={actionLoading === u.id || u.role === "admin"}
                          className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50 transition-colors"
                        >
                          <Ban size={12} />
                          Ban
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
