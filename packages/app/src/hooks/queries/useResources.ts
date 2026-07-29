/**
 * Typed React Query hooks for Categories and Auth resources.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { getMe } from "@/lib/api/auth";
import { queryKeys } from "@/lib/queryClient";

// ── Categories ────────────────────────────────────────────────────────────────

export function useCategories() {
  return useQuery({
    queryKey: queryKeys.categories.all(),
    queryFn: () => api.getCategories(),
    staleTime: 5 * 60_000, // categories rarely change
  });
}

// ── Auth / current user ────────────────────────────────────────────────────────

export function useMe() {
  return useQuery({
    queryKey: queryKeys.auth.me(),
    queryFn: () => getMe(),
    retry: 0, // don't retry auth errors
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.updateProfile>[0]) => api.updateProfile(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.me() }),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) =>
      api.changePassword(currentPassword, newPassword),
  });
}

// ── Bookmarks ─────────────────────────────────────────────────────────────────

export function useBookmarks(params?: Record<string, string>) {
  return useQuery({
    queryKey: queryKeys.bookmarks.list(params),
    queryFn: () => api.getMyBookmarks(params),
  });
}

export function useToggleBookmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) => api.toggleBookmark(workerId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bookmarks.list() }),
  });
}
