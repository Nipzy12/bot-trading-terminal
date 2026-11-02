import { useEffect, useState, type FormEvent } from "react";
type Connection = {
  id: string;
  label: string;
  status: "saved" | "verified" | "error";
  selected: boolean;
  tested_at: string | null;
};
type Session = { user: { name: string }; csrfToken: string };
export function AccountManagement() {
  const [enabled, setEnabled] = useState<boolean | null>(null),
    [session, setSession] = useState<Session | null>(null),
    [accounts, setAccounts] = useState<Connection[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [signup, setSignup] = useState(false),
    [showConnect, setShowConnect] = useState(false);
  async function call(path: string, method = "GET", body?: unknown) {
    const r = await fetch("/api/account" + path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET"
          ? { "X-CSRF-Token": session?.csrfToken ?? "" }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 401) setSession(null);
      throw Error(
        data.error === "CSRF_REJECTED"
          ? "Sesi berubah. Muat ulang halaman sebelum melanjutkan."
          : data.error === "CONNECTION_TEST_FAILED"
            ? "Test belum berhasil. Periksa izin read-only, akun, key dan Gateway melalui portal Exness."
            : data.error === "RATE_LIMITED"
              ? "Terlalu banyak permintaan. Tunggu sebelum mencoba lagi."
              : "Layanan belum tersedia atau permintaan ditolak.",
      );
    }
    return data;
  }
  async function load() {
    setAccounts([]);
    const r = await fetch("/api/account/session", {
      credentials: "same-origin",
    });
    if (!r.ok) {
      setSession(null);
      return;
    }
    setSession(await r.json());
    const data = await fetch("/api/account/connections", {
      credentials: "same-origin",
    });
    if (data.ok) setAccounts((await data.json()).accounts);
  }
  useEffect(() => {
    let active = true;
    fetch("/api/account/config")
      .then((r) => r.json())
      .then((d) => {
        if (active) {
          setEnabled(d.enabled);
          if (d.enabled)
            void load().catch(() => {
              if (active)
                setMessage("Sesi tidak dapat dimuat. Coba muat ulang halaman.");
            });
        }
      })
      .catch(() => {
        if (active) setEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch(
        "/api/auth/" + (signup ? "sign-up/email" : "sign-in/email"),
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: data.get("email"),
            password: data.get("password"),
            ...(signup ? { name: data.get("name") } : {}),
          }),
        },
      );
      if (!r.ok)
        throw Error(
          "Login/registrasi ditolak. Periksa email dan password, atau coba kembali nanti.",
        );
      await load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      form.reset();
      setBusy(false);
    }
  }
  async function connect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setMessage("");
    try {
      await call("/connections", "POST", Object.fromEntries(data));
      await load();
      setShowConnect(false);
      setMessage(
        "Kredensial disimpan terenkripsi. Jalankan Test Connection sebelum memilih akun.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      form.reset();
      setBusy(false);
    }
  }
  async function action(path: string, method: string, body?: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const result = await call(path, method, body);
      await load();
      setMessage(
        result.deleted
          ? "Disconnect selesai. Kredensial dihapus dari database aplikasi."
          : result.status === "verified"
            ? "Test Connection berhasil: candle EXNESS history tervalidasi. Bukan ticks live."
            : "Pilihan akun diperbarui.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="account-page">
      <header>
        <a className="logo" href="/">
          NEXUS <span>V3</span>
        </a>
        <a href="/">← Terminal DEMO</a>
      </header>
      <section className="account-intro">
        <span className="eyebrow">PRIVATE WORKSPACE</span>
        <h1>Account Management</h1>
        <p>
          Koneksi Exness read-only. Semua order, SL/TP dan robot tetap simulasi.
        </p>
      </section>
      {message && (
        <div role="status" className="account-message">
          {message}
        </div>
      )}
      {enabled === null ? (
        <p>Memeriksa layanan akun…</p>
      ) : !enabled ? (
        <section className="panel account-box">
          <h2>Account Management belum diaktifkan</h2>
          <p>
            Database, autentikasi atau secret enkripsi belum siap. Form
            kredensial dikunci. Terminal DEMO tetap tersedia.
          </p>
          <a href="/">Buka DEMO →</a>
        </section>
      ) : !session ? (
        <section className="panel account-box">
          <h2>
            {signup ? "Buat akun pengguna" : "Masuk ke workspace pribadi"}
          </h2>
          <p>
            Gunakan akun pengguna aplikasi. Jangan gunakan password Exness di
            sini.
          </p>
          <form onSubmit={login} autoComplete="on">
            {signup && (
              <label>
                Nama
                <input
                  required
                  name="name"
                  maxLength={60}
                  autoComplete="name"
                />
              </label>
            )}
            <label>
              Email
              <input
                required
                name="email"
                type="email"
                autoComplete="username"
              />
            </label>
            <label>
              Password aplikasi
              <input
                required
                name="password"
                type="password"
                minLength={12}
                maxLength={128}
                autoComplete={signup ? "new-password" : "current-password"}
              />
            </label>
            <button disabled={busy} type="submit" className="primary">
              {signup ? "Daftar" : "Masuk"}
            </button>
          </form>
          <button disabled={busy} onClick={() => setSignup(!signup)}>
            {signup ? "Sudah punya akun? Masuk" : "Belum punya akun? Daftar"}
          </button>
        </section>
      ) : (
        <>
          <section className="panel account-box">
            <div className="account-heading">
              <div>
                <h2>Workspace {session.user.name}</h2>
                <p>Hanya koneksi milik pengguna ini yang ditampilkan.</p>
              </div>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const response = await fetch("/api/auth/sign-out", {
                      method: "POST",
                      credentials: "same-origin",
                      headers: { "Content-Type": "application/json" },
                      body: "{}",
                    });
                    if (!response.ok)
                      throw Error(
                        "Logout gagal. Coba lagi sebelum meninggalkan perangkat.",
                      );
                    setSession(null);
                    setAccounts([]);
                  } catch (error) {
                    setMessage((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Keluar
              </button>
            </div>
            <button
              className="primary"
              disabled={busy}
              onClick={() => setShowConnect(!showConnect)}
            >
              Connect Exness
            </button>
          </section>
          {showConnect && (
            <section className="panel account-box">
              <h2>Connect Exness · read-only</h2>
              <p>
                Gunakan API key dengan Trading read access dari Key Management.
                Form dikirim melalui HTTPS ke backend, tanpa penyimpanan
                browser. Key tidak dapat dibaca kembali setelah disimpan.
              </p>
              <form onSubmit={connect} autoComplete="off">
                <label>
                  Nama koneksi
                  <input
                    name="label"
                    required
                    maxLength={60}
                    placeholder="Akun pribadi"
                    autoComplete="off"
                  />
                </label>
                <label>
                  API Key
                  <input
                    name="apiKey"
                    type="password"
                    required
                    maxLength={256}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Private Signing Key
                  <textarea
                    name="privateKey"
                    required
                    maxLength={4096}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="128 karakter hex atau Ed25519 PKCS#8 PEM"
                  />
                </label>
                <label>
                  Account ID
                  <input
                    name="accountId"
                    required
                    inputMode="numeric"
                    pattern="[1-9][0-9]{0,19}"
                    maxLength={20}
                    autoComplete="off"
                  />
                </label>
                <label>
                  Gateway URL
                  <input
                    name="gateway"
                    required
                    type="url"
                    placeholder="HTTPS Gateway dari DNS widget Exness"
                    maxLength={300}
                    autoComplete="off"
                  />
                </label>
                <label className="read-only-confirm">
                  <input type="checkbox" required />
                  Saya menggunakan koneksi data read-only. Tidak ada broker
                  order yang akan diaktifkan.
                </label>
                <button disabled={busy} type="submit" className="primary">
                  Simpan terenkripsi
                </button>
              </form>
            </section>
          )}
          <section className="panel account-box">
            <h2>Pilihan akun</h2>
            {accounts.length === 0 ? (
              <p>
                Belum ada koneksi Exness. DEMO publik tetap menjadi default.
              </p>
            ) : (
              accounts.map((a) => (
                <article className="connection-card" key={a.id}>
                  <div>
                    <h3>{a.label}</h3>
                    <span
                      className={a.status === "verified" ? "green" : "muted"}
                    >
                      {a.status === "verified"
                        ? "EXNESS · history teruji"
                        : a.status === "error"
                          ? "Test gagal"
                          : "Tersimpan · belum diuji"}
                    </span>
                    <p>
                      {a.tested_at
                        ? "Test terakhir: " +
                          new Date(a.tested_at).toLocaleString("id-ID")
                        : "Belum ada test koneksi"}
                      {a.selected ? " · Akun terpilih" : ""}
                    </p>
                  </div>
                  <div className="connection-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        action(`/connections/${a.id}/test`, "POST")
                      }
                    >
                      Test Connection
                    </button>
                    <button
                      disabled={busy || a.status !== "verified"}
                      onClick={() => action("/selection", "POST", { id: a.id })}
                    >
                      Pilih akun
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Disconnect dan hapus kredensial koneksi ini?",
                          )
                        )
                          void action(`/connections/${a.id}`, "DELETE");
                      }}
                    >
                      Disconnect & hapus
                    </button>
                  </div>
                </article>
              ))
            )}
            {accounts.some((a) => a.selected && a.status === "verified") && (
              <a className="private-terminal" href="/?feed=exness">
                Buka chart EXNESS history →
              </a>
            )}
          </section>
        </>
      )}
      <p className="account-footnote">
        Status teruji hanya mencerminkan test candle history terakhir, bukan
        koneksi live. Disconnect menghapus ciphertext aktif dari database
        aplikasi; Anda dapat mencabut API key di Key Management Exness.
      </p>
    </main>
  );
}
