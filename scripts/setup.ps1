param([switch]$Local)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
$requirements = Join-Path $projectRoot "requirements.txt"
$stampPath = Join-Path $projectRoot ".venv\requirements.sha256"

if (-not (Test-Path -LiteralPath $venvPython)) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) { throw "Python 3.11 이상을 설치하고 다시 실행해 주세요." }
    & $pythonCommand.Source -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
    if ($LASTEXITCODE -ne 0) { throw "Python 3.11 이상이 필요합니다." }
    Write-Host "프로젝트 전용 Python 환경을 준비합니다."
    & $pythonCommand.Source -m venv (Join-Path $projectRoot ".venv")
    if ($LASTEXITCODE -ne 0) { throw "Python 가상환경 생성에 실패했습니다." }
}
$requirementsHash = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash
$installedHash = if (Test-Path -LiteralPath $stampPath) { (Get-Content -LiteralPath $stampPath -Raw).Trim() } else { "" }
if ($installedHash -ne $requirementsHash) {
    Write-Host "서버 패키지를 설치합니다."
    & $venvPython -m pip install --disable-pip-version-check -r $requirements
    if ($LASTEXITCODE -ne 0) { throw "패키지 설치에 실패했습니다. 인터넷 연결을 확인해 주세요." }
    Set-Content -LiteralPath $stampPath -Value $requirementsHash -Encoding ASCII
}

if (-not $Local) {
    $binaryDirectory = Join-Path $projectRoot "bin"
    $tunnelBinary = Join-Path $binaryDirectory "cloudflared.exe"
    if (-not (Test-Path -LiteralPath $tunnelBinary)) {
        if (-not [Environment]::Is64BitOperatingSystem) { throw "이 실행 스크립트는 Windows 64비트 환경용입니다." }
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Host "Cloudflare 공식 Windows 실행 파일을 준비합니다."
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/cloudflare/cloudflared/releases/latest" -Headers @{"User-Agent"="OneTimeDownloadService-Setup"}
        $asset = $release.assets | Where-Object { $_.name -eq "cloudflared-windows-amd64.exe" } | Select-Object -First 1
        if (-not $asset) { throw "공식 릴리스에서 Windows 실행 파일을 찾지 못했습니다." }
        $expectedHash = ""
        if ($asset.PSObject.Properties.Name -contains "digest" -and $asset.digest -match "^sha256:([a-fA-F0-9]{64})$") {
            $expectedHash = $Matches[1]
        } elseif ($release.body -match "cloudflared-windows-amd64\.exe:\s*([a-fA-F0-9]{64})") {
            $expectedHash = $Matches[1]
        }
        if (-not $expectedHash) { throw "공식 SHA-256 체크섬을 확인할 수 없습니다. 다운로드를 중단했습니다." }
        New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
        $temporaryBinary = Join-Path $binaryDirectory "cloudflared.download"
        try {
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $temporaryBinary -UseBasicParsing
            $actualHash = (Get-FileHash -LiteralPath $temporaryBinary -Algorithm SHA256).Hash
            if ($actualHash -ne $expectedHash) { throw "cloudflared SHA-256 검증에 실패했습니다." }
            Move-Item -LiteralPath $temporaryBinary -Destination $tunnelBinary
            Set-Content -LiteralPath (Join-Path $binaryDirectory "cloudflared.version") -Value $release.tag_name -Encoding ASCII
        } finally {
            if (Test-Path -LiteralPath $temporaryBinary) { Remove-Item -LiteralPath $temporaryBinary }
        }
    }
    & $tunnelBinary --version
    if ($LASTEXITCODE -ne 0) { throw "cloudflared를 실행할 수 없습니다." }
}
Write-Host "설치 준비를 완료했습니다."
