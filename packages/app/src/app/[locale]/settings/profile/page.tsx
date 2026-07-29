"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api";

interface UserProfile {
  firstName: string;
  lastName: string;
  email: string;
}

export default function ProfileSettingsPage() {
  const router = useRouter();
  const { user, token, isLoading, login, logout } = useAuth();

  const [profile, setProfile] = useState<UserProfile>({
    firstName: "",
    lastName: "",
    email: "",
  });
  const [profileErrors, setProfileErrors] = useState<Partial<UserProfile>>({});
  const [profileSaving, setProfileSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(""), 3500);
  };

  useEffect(() => {
    if (!isLoading && !user) router.replace("/auth/login");
  }, [isLoading, router, user]);

  useEffect(() => {
    if (!user) return;
    setProfile({
      firstName: user.firstName ?? "",
      lastName: user.lastName ?? "",
      email: user.email ?? "",
    });
  }, [user]);

  const getAuthHeaders = () => ({
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  const validateProfile = () => {
    const errors: Partial<UserProfile> = {};

    if (!profile.firstName.trim()) errors.firstName = "First name is required";
    if (!profile.lastName.trim()) errors.lastName = "Last name is required";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
      errors.email = "Enter a valid email";
    }

    setProfileErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleProfileSave = async () => {
    if (!validateProfile()) return;

    setProfileSaving(true);
    try {
      const res = await fetch(`${API}/users/me`, {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify(profile),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(json.message ?? "Failed to save profile.");
      if (user && token) login({ ...user, ...profile }, token);
      showToast("Profile saved!");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save profile.");
    } finally {
      setProfileSaving(false);
    }
  };

  const handlePasswordChange = async () => {
    if (!currentPassword) {
      setPasswordError("Current password is required.");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters.");
      return;
    }

    setPasswordError("");
    setPasswordSaving(true);
    try {
      const res = await fetch(`${API}/users/me/password`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.status === 401) {
        setPasswordError("Current password is incorrect.");
        return;
      }
      if (!res.ok) throw new Error(json.message ?? "Failed to update password.");

      setCurrentPassword("");
      setNewPassword("");
      showToast("Password updated!");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update password.");
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirm !== "DELETE") return;

    setDeleting(true);
    try {
      const res = await fetch(`${API}/users/me`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed to delete account.");
      logout();
      router.replace("/");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete account.");
    } finally {
      setDeleting(false);
      setShowDeleteModal(false);
      setDeleteConfirm("");
    }
  };

  if (isLoading || !user) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 size={24} className="animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-10 px-4 py-10">
      <h1 className="text-2xl font-bold text-gray-900">Profile Settings</h1>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Personal Information</h2>
        {(["firstName", "lastName", "email"] as (keyof UserProfile)[]).map((field) => (
          <div key={field}>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              {field === "firstName" ? "First name" : field === "lastName" ? "Last name" : "Email"}
            </label>
            <input
              type={field === "email" ? "email" : "text"}
              value={profile[field]}
              onChange={(event) =>
                setProfile((current) => ({ ...current, [field]: event.target.value }))
              }
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {profileErrors[field] && (
              <p className="mt-1 text-xs text-red-600">{profileErrors[field]}</p>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={handleProfileSave}
          disabled={profileSaving}
          className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {profileSaving ? "Saving..." : "Save changes"}
        </button>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Change Password</h2>
        <input
          type="password"
          placeholder="Current password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          type="password"
          placeholder="New password (min 8 chars)"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        {passwordError && <p className="text-xs text-red-600">{passwordError}</p>}
        <button
          type="button"
          onClick={handlePasswordChange}
          disabled={passwordSaving}
          className="rounded-lg bg-gray-800 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-900 disabled:opacity-50"
        >
          {passwordSaving ? "Updating..." : "Update password"}
        </button>
      </section>

      <section className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-5">
        <h2 className="text-lg font-semibold text-red-700">Danger Zone</h2>
        <p className="text-sm text-red-600">Permanently delete your account and all data.</p>
        <button
          type="button"
          onClick={() => setShowDeleteModal(true)}
          className="rounded-lg border border-red-500 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-100"
        >
          Delete account
        </button>
      </section>

      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm space-y-4 rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900">Delete your account?</h3>
            <p className="text-sm text-gray-600">
              Type <strong>DELETE</strong> to confirm. This cannot be undone.
            </p>
            <input
              value={deleteConfirm}
              onChange={(event) => setDeleteConfirm(event.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              placeholder="DELETE"
            />
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleDeleteAccount}
                disabled={deleteConfirm !== "DELETE" || deleting}
                className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleting ? "Deleting..." : "Confirm delete"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirm("");
                }}
                className="flex-1 rounded-lg border py-2 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white shadow-lg -translate-x-1/2"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
