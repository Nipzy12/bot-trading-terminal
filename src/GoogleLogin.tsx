import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { authMessage, createGoogleLogin } from "./firebase-login";

type Client = ReturnType<typeof createGoogleLogin>;
export function GoogleLogin() {
  const [client, setClient] = useState<Client>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let dispose: (() => void) | undefined;
    try {
      const auth = createGoogleLogin(import.meta.env);
      setClient(auth);
      if (!auth) {
        setMessage(
          "Google Login belum dikonfigurasi (VITE_FIREBASE_*). Dashboard DEMO tetap tersedia tanpa login.",
        );
        setLoading(false);
        return;
      }
      dispose = auth.observe(
        (value) => {
          setUser(value);
          setLoading(false);
        },
        () => {
          setLoading(false);
          setClient(null);
          setMessage(
            "Status login tidak dapat dimuat. Muat ulang untuk mencoba kembali.",
          );
        },
      );
    } catch (error) {
      setMessage(authMessage(error));
      setLoading(false);
    }
    return () => dispose?.();
  }, []);
  async function act() {
    if (!client || busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (user) await client.logout();
      else await client.login();
    } catch (error) {
      setMessage(authMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="google-login"
      aria-label="Akun Google NEXUS"
      aria-busy={loading || busy}
    >
      <div>
        <strong>
          {user ? user.displayName || "Pengguna Google" : "Akun NEXUS"}
        </strong>
        <span role="status">
          {loading
            ? "Memuat status login…"
            : busy
              ? "Memproses…"
              : user
                ? "Login Google aktif"
                : "Belum login · DEMO publik"}
        </span>
        {user?.email && <span>{user.email}</span>}
      </div>
      <button disabled={loading || busy || !client} onClick={() => void act()}>
        {user ? "Logout Google" : "Login with Google"}
      </button>
      {message && <p role="status">{message}</p>}
      <small>
        Google Login untuk profil NEXUS. Akses Exness tetap memerlukan sesi akun
        aman yang sudah ada.
      </small>
    </section>
  );
}
