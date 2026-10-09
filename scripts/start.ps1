param([switch]$Local, [int]$Port = 8080)
$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"
$projectRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot "setup.ps1") -Local:$Local
$pythonExecutable = Join-Path $projectRoot ".venv\Scripts\python.exe"
$runtimeArguments = @((Join-Path $projectRoot "runtime.py"), "--port", $Port.ToString())
if ($Local) { $runtimeArguments += "--local" }
& $pythonExecutable @runtimeArguments
if ($LASTEXITCODE -ne 0) { throw "서비스 실행에 실패했습니다." }
