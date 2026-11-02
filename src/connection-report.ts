export const stageLabels = {
  configuration: "Persiapan koneksi",
  discovery: "Gateway discovery",
  account_details: "Autentikasi · account details (read-only)",
  limits: "API limits",
  candles: "XAUUSD · H1 candle history",
} as const;
export const categoryMessages = {
  EXNESS_AUTH:
    "Autentikasi ditolak pada tahap ini. Periksa key, signature dan waktu; tahap sebelumnya tetap tercatat.",
  EXNESS_PERMISSION:
    "Akses tahap ini ditolak. Periksa akun, izin read-only dan pembatasan IP; jangan ubah ke full access.",
  EXNESS_NETWORK: "DNS, TLS atau koneksi jaringan gagal pada tahap ini.",
  EXNESS_INVALID_RESPONSE:
    "Respons tahap ini tidak sesuai kontrak atau data tidak tersedia dalam bentuk yang valid.",
  EXNESS_LIMITS_UNAVAILABLE:
    "Batas candle yang diperlukan belum tersedia dari konfigurasi API.",
  RATE_LIMITED:
    "Batas request tercapai. Tunggu sebelum mencoba lagi secara manual.",
  TIMEOUT: "Batas waktu tahap ini atau keseluruhan test habis.",
  EXNESS_SSRF:
    "Host atau alamat IP ditolak oleh proteksi jaringan. Periksa Gateway resmi dari DNS widget.",
  EXNESS_CONFIGURATION:
    "Konfigurasi koneksi belum dapat dimuat atau divalidasi.",
  EXNESS_MARKET_DATA:
    "Data instrumen/candle belum tersedia. Ini tidak berarti API Key salah.",
  EXNESS_UPSTREAM: "Provider menolak atau belum dapat melayani tahap ini.",
  ACCOUNT_SERVICE_UNAVAILABLE: "Layanan akun sementara tidak tersedia.",
  CONNECTION_DELETED: "Koneksi sudah dihapus.",
} as const;
export type ClientReport = {
  stage?: keyof typeof stageLabels;
  error?: keyof typeof categoryMessages;
  stages: {
    stage: Exclude<keyof typeof stageLabels, "configuration">;
    status: "passed" | "failed" | "not_run";
  }[];
};
export function parseReport(value: unknown): ClientReport | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.stages)) return null;
  return {
    stage:
      typeof v.stage === "string" && Object.hasOwn(stageLabels, v.stage)
        ? (v.stage as ClientReport["stage"])
        : undefined,
    error:
      typeof v.error === "string" && Object.hasOwn(categoryMessages, v.error)
        ? (v.error as ClientReport["error"])
        : undefined,
    stages: (
      ["discovery", "account_details", "limits", "candles"] as const
    ).map((stage) => {
      const row = v.stages as Record<string, unknown>[];
      const candidate = row.find((r) => r && r.stage === stage)?.status;
      return {
        stage,
        status:
          candidate === "passed" || candidate === "failed"
            ? candidate
            : "not_run",
      };
    }),
  };
}
