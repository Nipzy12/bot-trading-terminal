param(
  [Parameter(Mandatory=$true)]
  [ValidateSet("setup","read","status","forget")]
  [string]$Action
)
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "WINDOWS_ONLY" }
$base = Join-Path $env:LOCALAPPDATA "NEXUS\Engine"
$vault = Join-Path $base "exness-readonly.dpapi"

function Reveal([System.Security.SecureString]$secret) {
  $handle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($handle) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handle) }
}

try {
  switch ($Action) {
    "status" {
      if (Test-Path -LiteralPath $vault) { Write-Output "Vault Windows DPAPI: TERSEDIA (tidak menampilkan rahasia)." }
      else { Write-Output "Vault Windows DPAPI: BELUM DIKONFIGURASI." }
    }
    "forget" {
      if (Test-Path -LiteralPath $vault) { Remove-Item -LiteralPath $vault -Force }
      Write-Output "Vault lokal dihapus. Cabut API key di Exness Key Management jika perlu."
    }
    "setup" {
      Write-Host "NEXUS V6.2C: isi hanya API key TRADING READ-ONLY yang terpisah."
      Write-Host "Data disimpan terenkripsi DPAPI dalam profil Windows, bukan di repository atau Vercel."
      $accept = Read-Host "Ketik READONLY untuk menyatakan scope Trading Read-only telah dipilih di Exness"
      if ($accept -cne "READONLY") { throw "READONLY_CONFIRMATION_REQUIRED" }
      $accountId = (Read-Host "Exness account ID (angka)").Trim()
      $gateway = (Read-Host "Gateway HTTPS resmi Exness (tanpa path)").Trim()
      if ($accountId -notmatch "^[1-9][0-9]{0,19}$" -or $gateway -notmatch "^https://[A-Za-z0-9.-]+/?$") {
        throw "INVALID_LOCAL_CONFIGURATION"
      }
      $api = Read-Host "API key READ-ONLY (input tersembunyi)" -AsSecureString
      $private = Read-Host "Private signing key Ed25519 128 hex (input tersembunyi)" -AsSecureString
      $apiPlain = Reveal $api
      $privatePlain = Reveal $private
      if ($apiPlain.Length -lt 8 -or $apiPlain.Length -gt 256 -or
          $privatePlain -cnotmatch "^[0-9a-fA-F]{128}$") {
        throw "INVALID_CREDENTIAL_FORMAT"
      }
      $packed = ConvertTo-Json -Compress -InputObject @{
        apiKey = $apiPlain
        privateKey = $privatePlain
        accountId = $accountId
        gateway = $gateway.TrimEnd("/")
      }
      $sealed = ConvertTo-SecureString -AsPlainText -Force -String $packed |
        ConvertFrom-SecureString
      $apiPlain = $null
      $privatePlain = $null
      $packed = $null
      $api.Dispose()
      $private.Dispose()
      if (-not (Test-Path -LiteralPath $base)) {
        New-Item -ItemType Directory -Path $base -Force | Out-Null
      }
      Set-Content -LiteralPath $vault -Value $sealed -Encoding Ascii -NoNewline
      Write-Output "Kredensial lokal tersimpan dengan DPAPI CurrentUser. Broker belum dihubungi."
    }
    "read" {
      if (-not (Test-Path -LiteralPath $vault)) { throw "VAULT_NOT_CONFIGURED" }
      $sealed = Get-Content -LiteralPath $vault -Raw
      $secure = ConvertTo-SecureString -String $sealed
      $handle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try {
        # Only to the private stdout pipe consumed by the local Node process.
        # Never run this mode manually or redirect its output to a file.
        [Console]::Out.WriteLine([Runtime.InteropServices.Marshal]::PtrToStringBSTR($handle))
      } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handle)
        $secure.Dispose()
      }
    }
  }
} catch {
  [Console]::Error.WriteLine("LOCAL_VAULT_OPERATION_FAILED")
  exit 1
}
