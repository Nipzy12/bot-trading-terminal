import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  popup: vi.fn(),
  out: vi.fn(),
  observe: vi.fn(),
  init: vi.fn(() => ({})),
  params: vi.fn(),
}));
vi.mock("firebase/app", () => ({
  getApps: () => [],
  initializeApp: mocks.init,
}));
vi.mock("firebase/auth", () => ({
  getAuth: () => ({}),
  GoogleAuthProvider: class {
    setCustomParameters = mocks.params;
  },
  onAuthStateChanged: mocks.observe,
  signInWithPopup: mocks.popup,
  signOut: mocks.out,
}));
import {
  authMessage,
  createGoogleLogin,
  firebaseConfig,
} from "../src/firebase-login";
const env = {
  VITE_FIREBASE_API_KEY: "public-web-config",
  VITE_FIREBASE_AUTH_DOMAIN: "test-project.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "test-project",
  VITE_FIREBASE_APP_ID: "test-app",
};
describe("Firebase profile authentication", () => {
  beforeEach(() => vi.clearAllMocks());
  it("keeps missing or partial configuration inert", () => {
    expect(createGoogleLogin({})).toBeNull();
    expect(createGoogleLogin({ ...env, VITE_FIREBASE_APP_ID: " " })).toBeNull();
    expect(mocks.init).not.toHaveBeenCalled();
  });
  it("rejects auth handlers outside the CSP", () => {
    expect(
      firebaseConfig({ ...env, VITE_FIREBASE_AUTH_DOMAIN: "evil.example" }),
    ).toBeNull();
  });
  it("uses Google popup, observes session and signs out without backend privileges", async () => {
    const client = createGoogleLogin(env)!;
    const next = vi.fn(),
      fail = vi.fn();
    client.observe(next, fail);
    await client.login();
    await client.logout();
    expect(mocks.observe).toHaveBeenCalledWith(expect.anything(), next, fail);
    expect(mocks.popup).toHaveBeenCalledTimes(1);
    expect(mocks.out).toHaveBeenCalledTimes(1);
    expect(mocks.params).toHaveBeenCalledWith({ prompt: "select_account" });
  });
  it.each([
    "auth/popup-blocked",
    "auth/popup-closed-by-user",
    "auth/unauthorized-domain",
    "auth/network-request-failed",
    "auth/operation-not-allowed",
    "unknown",
  ])("projects safe message for %s", (code) => {
    const message = authMessage({
      code,
      message: "secret-token-raw-exception",
    });
    expect(message).not.toContain("secret-token");
    expect(message.length).toBeGreaterThan(20);
  });
});
