import { getApps, initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";

export function firebaseConfig(env: Record<string, unknown>) {
  const keys = ["API_KEY", "AUTH_DOMAIN", "PROJECT_ID", "APP_ID"] as const;
  if (
    keys.some(
      (key) =>
        typeof env[`VITE_FIREBASE_${key}`] !== "string" ||
        !(env[`VITE_FIREBASE_${key}`] as string).trim(),
    )
  )
    return null;
  const authDomain = String(env.VITE_FIREBASE_AUTH_DOMAIN).trim();
  // Only Firebase's hosted auth handler is allowed by the deployed CSP.
  if (!/^[a-z0-9-]+\.firebaseapp\.com$/.test(authDomain)) return null;
  return {
    apiKey: String(env.VITE_FIREBASE_API_KEY).trim(),
    authDomain,
    projectId: String(env.VITE_FIREBASE_PROJECT_ID).trim(),
    appId: String(env.VITE_FIREBASE_APP_ID).trim(),
  };
}
export function authMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : "";
  switch (code) {
    case "auth/popup-closed-by-user":
      return "Login dibatalkan. Anda tetap dapat memakai DEMO.";
    case "auth/popup-blocked":
      return "Izinkan pop-up untuk situs NEXUS, lalu coba Login with Google kembali. Gunakan Chrome atau browser utama, bukan browser dalam aplikasi.";
    case "auth/unauthorized-domain":
      return "Domain NEXUS belum diizinkan di Firebase Authentication.";
    case "auth/operation-not-allowed":
      return "Provider Google belum diaktifkan di Firebase Authentication.";
    case "auth/network-request-failed":
      return "Koneksi login gagal. Periksa jaringan dan coba kembali.";
    default:
      return "Login Google belum tersedia. Periksa konfigurasi Firebase atau coba kembali nanti.";
  }
}
export function createGoogleLogin(env: Record<string, unknown>) {
  const config = firebaseConfig(env);
  if (!config) return null;
  const app =
    getApps().find((app) => app.name === "nexus-google") ??
    initializeApp(config, "nexus-google");
  const auth = getAuth(app);
  auth.languageCode = "id";
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return {
    observe: (next: (user: User | null) => void, fail: () => void) =>
      onAuthStateChanged(auth, next, fail),
    login: () => signInWithPopup(auth, provider),
    logout: () => signOut(auth),
  };
}
