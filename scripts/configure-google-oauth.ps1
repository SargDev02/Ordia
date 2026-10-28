# Ejecutar en una terminal local: nunca introducir estas credenciales en el chat.
$ErrorActionPreference = 'Stop'
$ordiaRoot = Split-Path -Parent $PSScriptRoot
$ordiaRef = 'dedtyhomynsmvatfnshs'
$ordiaRelative = 'supabase/functions/.env.google'
$ordiaTarget = Join-Path $ordiaRoot $ordiaRelative
Push-Location -LiteralPath $ordiaRoot
try {
    & git check-ignore --quiet $ordiaRelative
    if ($LASTEXITCODE -ne 0) { throw 'El archivo de credenciales no está ignorado por Git.' }
    if (Test-Path -LiteralPath $ordiaTarget) { throw 'Ya existe .env.google. No se reemplazó; revisa la configuración existente antes de rotar credenciales.' }
    $ordiaProjectsOutput = & pnpm exec supabase projects list --output json 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo verificar Supabase. Inicia sesión en la CLI y vuelve a ejecutar.' }
    $ordiaProjects = ($ordiaProjectsOutput -join "`n") | ConvertFrom-Json
    # La CLI devuelve un array; versiones que lo envuelvan deben verificarse explícitamente.
    $ordiaProject = @($ordiaProjects) | Where-Object { $_.id -eq $ordiaRef -or $_.ref -eq $ordiaRef }
    if (@($ordiaProject).Count -ne 1 -or $ordiaProject.name -ne 'Ordia') { throw 'No se verificó el proyecto Ordia autorizado. No se guardaron secretos.' }
    $ordiaIdSecure = Read-Host 'Client ID del cliente Web OAuth dedicado a Ordia' -AsSecureString
    $ordiaSecretSecure = Read-Host 'Client secret de ese cliente (entrada oculta)' -AsSecureString
    $ordiaId = [System.Net.NetworkCredential]::new('', $ordiaIdSecure).Password
    $ordiaSecret = [System.Net.NetworkCredential]::new('', $ordiaSecretSecure).Password
    if ($ordiaId -notmatch '^[A-Za-z0-9.-]+\.apps\.googleusercontent\.com$' -or $ordiaSecret -notmatch '^[A-Za-z0-9_-]{10,}$') { throw 'Formato de credenciales no válido. No se guardaron.' }
    $ordiaContent = "GOOGLE_OAUTH_CLIENT_ID=$ordiaId`nGOOGLE_OAUTH_CLIENT_SECRET=$ordiaSecret`n"
    [System.IO.File]::WriteAllText($ordiaTarget, $ordiaContent, [System.Text.UTF8Encoding]::new($false))
    $ordiaContent = $null; $ordiaSecret = $null; $ordiaId = $null
    $ordiaUpload = & pnpm exec supabase secrets set --env-file $ordiaRelative --project-ref $ordiaRef 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'No se confirmó la carga. El archivo local está ignorado; reintenta secrets set sin mostrar su contenido.' }
    $ordiaUpload = $null
    Write-Host 'Credenciales guardadas localmente y cargadas únicamente en Ordia. No se imprimieron sus valores.'
} finally {
    $ordiaSecret = $null; $ordiaId = $null; $ordiaContent = $null
    if ($ordiaIdSecure) { $ordiaIdSecure.Dispose() }
    if ($ordiaSecretSecure) { $ordiaSecretSecure.Dispose() }
    Pop-Location
}
