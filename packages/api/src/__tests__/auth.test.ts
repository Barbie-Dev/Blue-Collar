/**
 * Unit tests for the auth controller (src/controllers/auth.ts).
 *
 * All external dependencies (auth service, db, nodemailer) are mocked.
 *
 * Error-handling contract: handlers now use `catchAsync`, so errors are
 * forwarded to `next(err)` rather than handled inline.  Error-case tests
 * assert that `next` was called with an AppError carrying the expected
 * status code and message.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Env setup (must run before any module that reads process.env) ─────────────
process.env.JWT_SECRET = "test-secret";
process.env.APP_URL = "http://localhost:3000";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../services/auth.service.js", () => ({
  registerUser: vi.fn(),
  loginUser: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  verifyAccount: vi.fn(),
  revokeAllRefreshTokens: vi.fn(),
  rotateRefreshToken: vi.fn(),
  resendVerificationEmail: vi.fn(),
}));

vi.mock("../db.js", () => ({
  db: {
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("../config/env.js", () => ({
  env: {
    DATABASE_URL: "postgresql://localhost:5432/test",
    JWT_SECRET: "test-secret",
    PORT: 3000,
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    MAIL_HOST: "smtp.test.local",
    MAIL_PORT: 587,
    MAIL_USER: "test-user",
    MAIL_PASS: "test-pass",
    APP_URL: "http://localhost:3000",
  },
}));

// Prevent nodemailer from opening real SMTP connections
vi.mock("../mailer/transport.js", () => ({
  transporter: {
    sendMail: vi.fn().mockResolvedValue({ messageId: "mock-message-id" }),
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import * as authService from "../services/auth.service.js";
import { db } from "../db.js";
import {
  register,
  login,
  logout,
  forgotPassword,
  resetPassword,
  refresh,
  me,
  resendVerification,
} from "../controllers/auth.js";
import { AppError } from "../utils/AppError.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.redirect = vi.fn().mockReturnValue(res);
  return res;
}

function makeReq(body: Record<string, any> = {}, user?: any, query: Record<string, any> = {}): any {
  return { body, user, query, get: () => undefined };
}

/** Call a catchAsync handler and capture what was passed to next. */
async function callHandler(
  handler: (req: any, res: any, next: any) => any,
  req: any,
  res: any,
): Promise<{ nextError: unknown }> {
  let nextError: unknown = undefined;
  await handler(req, res, (err: unknown) => { nextError = err });
  return { nextError };
}

const mockUser = {
  id: "user-1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Smith",
  role: "user",
  verified: true,
  password: "hashed-password",
  googleId: null,
  walletAddress: null,
  avatar: null,
  bio: null,
  phone: null,
  locationId: null,
  resetToken: null,
  resetTokenExpiry: null,
  verificationToken: null,
  verificationTokenExpiry: null,
  unsubscribedReminders: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── register ─────────────────────────────────────────────────────────────────

describe("register", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 201 with user data on success", async () => {
    (authService.registerUser as any).mockResolvedValue(mockUser);
    const req = makeReq({ email: "alice@example.com", password: "secret", firstName: "Alice", lastName: "Smith" });
    const res = makeRes();

    const { nextError } = await callHandler(register, req, res);

    expect(nextError).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
    expect(body.code).toBe(201);
    expect(body.message).toMatch(/registration successful/i);
    expect(body.data).toBeDefined();
  });

  it("forwards AppError 409 when the email is already registered", async () => {
    (authService.registerUser as any).mockRejectedValue(
      new AppError("Email already in use", 409),
    );
    const req = makeReq({ email: "alice@example.com", password: "secret", firstName: "Alice", lastName: "Smith" });
    const res = makeRes();

    const { nextError } = await callHandler(register, req, res);

    expect(nextError).toBeInstanceOf(AppError);
    expect((nextError as AppError).statusCode).toBe(409);
    expect((nextError as AppError).message).toBe("Email already in use");
  });

  it("forwards AppError 422 when required fields are missing", async () => {
    (authService.registerUser as any).mockRejectedValue(
      new AppError("Validation failed", 422),
    );
    const req = makeReq({});
    const res = makeRes();

    const { nextError } = await callHandler(register, req, res);

    expect(nextError).toBeInstanceOf(AppError);
    expect((nextError as AppError).statusCode).toBe(422);
  });
});

// ─── login ────────────────────────────────────────────────────────────────────

describe("login", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 202 with user data and a JWT token on success", async () => {
    (authService.loginUser as any).mockResolvedValue({
      data: mockUser,
      token: "signed-jwt",
      refreshToken: "refresh-token",
      deviceId: "device-1",
    });
    const req = makeReq({ email: "alice@example.com", password: "secret" });
    const res = makeRes();

    const { nextError } = await callHandler(login, req, res);

    expect(nextError).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(202);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
    expect(body.token).toBe("signed-jwt");
    expect(body.code).toBe(202);
  });

  it("forwards AppError 401 for wrong password", async () => {
    (authService.loginUser as any).mockRejectedValue(
      new AppError("Invalid credentials", 401),
    );
    const req = makeReq({ email: "alice@example.com", password: "wrong-password" });
    const res = makeRes();

    const { nextError } = await callHandler(login, req, res);

    expect(nextError).toBeInstanceOf(AppError);
    expect((nextError as AppError).statusCode).toBe(401);
  });

  it("forwards AppError 401 for non-existent user", async () => {
    (authService.loginUser as any).mockRejectedValue(
      new AppError("Invalid credentials", 401),
    );
    const req = makeReq({ email: "ghost@example.com", password: "secret" });
    const res = makeRes();

    const { nextError } = await callHandler(login, req, res);

    expect(nextError).toBeInstanceOf(AppError);
    expect((nextError as AppError).statusCode).toBe(401);
  });

  it("forwards AppError 403 for unverified account", async () => {
    (authService.loginUser as any).mockRejectedValue(
      new AppError(
        "Your email address has not been verified. Please check your inbox and click the verification link.",
        403,
      ),
    );
    const req = makeReq({ email: "alice@example.com", password: "secret" });
    const res = makeRes();

    const { nextError } = await callHandler(login, req, res);

    expect(nextError).toBeInstanceOf(AppError);
    expect((nextError as AppError).statusCode).toBe(403);
  });
});

// ─── logout ───────────────────────────────────────────────────────────────────

describe("logout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with a success message for an authenticated user", async () => {
    (authService.revokeAllRefreshTokens as any).mockResolvedValue(undefined);
    const req = makeReq({}, { id: "user-1", role: "user" });
    const res = makeRes();

    const { nextError } = await callHandler(logout, req, res);

    expect(nextError).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", message: "Logged out", code: 200 }),
    );
  });

  it("returns 200 even without an authenticated user (auth enforced by middleware)", async () => {
    const req = makeReq();
    const res = makeRes();

    const { nextError } = await callHandler(logout, req, res);

    expect(nextError).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ─── forgotPassword ───────────────────────────────────────────────────────────

describe("forgotPassword", () => {
  beforeEach(() => vi.clearAllMocks());

  it("always returns 200 to avoid leaking user existence", async () => {
    (authService.requestPasswordReset as any).mockResolvedValue(undefined);
    const req = makeReq({ email: "ghost@example.com" });
    const res = makeRes();

    const { nextError } = await callHandler(forgotPassword, req, res);

    expect(nextError).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", code: 200 }),
    );
  });

  it("calls requestPasswordReset with the provided email", async () => {
    (authService.requestPasswordReset as any).mockResolvedValue(undefined);
    const req = makeReq({ email: "alice@example.com" });
    const res = makeRes();

    await callHandler(forgotPassword, req, res);

    expect(authService.requestPasswordReset).toHaveBeenCalledOnce();
    expect(authService.requestPasswordReset).toHaveBeenCalledWith("alice@example.com");
  });
});

// ─── resetPassword ────────────────────────────────────────────────────────────

describe("resetPassword", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 on a successful password reset", async () => {
    (authService.resetPassword as any).mockResolvedValue(undefined);
    const req = makeReq({ token: "valid-reset-token", password: "new-secure-password" });
    const res = makeRes();

    const { nextError } = await callHandler(resetPassword, req, res);

    expect(nextError).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", message: "Password reset successful", code: 200 }),
    );
  });

  it("forwards AppError 400 when token and password are missing", async () => {
    const req = makeReq({});
    const res = makeRes();

    const { nextError } = await callHandler(resetPassword, req, res);

    expect(nextError).toBeInstanceOf(AppError);
    expect((nextError as AppError).statusCode).toBe(400);
    expect((nextError as AppError).message).toBe("Token and password are required");
  });

  it("forwards AppError 400 for an expired reset token", async () => {
    (authService.resetPassword as any).mockRejectedValue(
      new AppError("Token is invalid or has expired", 400),
    );
    const req = makeReq({ token: "expired-token", password: "new-secure-password" });
    const res = makeRes();

    const { nextError } = await callHandler(resetPassword, req, res);

    expect(nextError).toBeInstanceOf(AppError);
    expect((nextError as AppError).statusCode).toBe(400);
  });

  it("forwards AppError 400 for an invalid reset token", async () => {
    (authService.resetPassword as any).mockRejectedValue(
      new AppError("Token is invalid or has expired", 400),
    );
    const req = makeReq({ token: "tampered-token", password: "new-secure-password" });
    const res = makeRes();

    const { nextError } = await callHandler(resetPassword, req, res);

    expect(nextError).toBeInstanceOf(AppError);
    expect((nextError as AppError).statusCode).toBe(400);
  });
});

// ─── refresh ─────────────────────────────────────────────────────────────────

describe("refresh", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with new tokens on success", async () => {
    (authService.rotateRefreshToken as any).mockResolvedValue({
      token: "new-access-token",
      refreshToken: "new-refresh-token",
    });
    const req = makeReq({ refreshToken: "old-refresh-token" });
    const res = makeRes();

    const { nextError } = await callHandler(refresh, req, res);

    expect(nextError).toBeUndefined();
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
    expect(body.token).toBe("new-access-token");
  });

  it("forwards AppError 400 when refreshToken is missing", async () => {
    const req = makeReq({});
    const res = makeRes();

    const { nextError } = await callHandler(refresh, req, res);

    expect(nextError).toBeInstanceOf(AppError);
    expect((nextError as AppError).statusCode).toBe(400);
    expect((nextError as AppError).message).toBe("refreshToken is required");
  });
});

// ─── me ───────────────────────────────────────────────────────────────────────

describe("me", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with user data when user exists", async () => {
    (db.user.findUnique as any).mockResolvedValue(mockUser);
    const req = makeReq({}, { id: "user-1", role: "user" });
    const res = makeRes();

    const { nextError } = await callHandler(me, req, res);

    expect(nextError).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
  });

  it("forwards AppError 404 when user no longer exists", async () => {
    (db.user.findUnique as any).mockResolvedValue(null);
    const req = makeReq({}, { id: "deleted-user", role: "user" });
    const res = makeRes();

    const { nextError } = await callHandler(me, req, res);

    expect(nextError).toBeInstanceOf(AppError);
    expect((nextError as AppError).statusCode).toBe(404);
    expect((nextError as AppError).message).toBe("User not found");
  });
});

// ─── resendVerification ───────────────────────────────────────────────────────

describe("resendVerification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("always returns 200 to avoid enumeration", async () => {
    (authService.resendVerificationEmail as any).mockResolvedValue(undefined);
    const req = makeReq({ email: "alice@example.com" });
    const res = makeRes();

    const { nextError } = await callHandler(resendVerification, req, res);

    expect(nextError).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
  });
});
