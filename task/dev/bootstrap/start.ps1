# Set up a Term development environment on Windows.
#
#   powershell -ExecutionPolicy Bypass -File task\dev\bootstrap\start.ps1 check
#   powershell -ExecutionPolicy Bypass -File task\dev\bootstrap\start.ps1 install
#   powershell -ExecutionPolicy Bypass -File task\dev\bootstrap\start.ps1 install --commit
#
# The setup itself is a Term program (base.tree beside this file), so this only puts in place what that program
# needs to run: Node, pnpm, the workspace's packages and the Term CLI, each only when --commit is given. Then it hands
# every argument to base.tree.
$ErrorActionPreference = 'Stop'

$PnpmVersion = '12.8.1'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $Here '..\..\..')
$Commit = $args -contains '--commit'

# PATH as the machine and the user now have it, so a tool winget just installed is found
function Update-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    return 0
  }
  $version = (& node --version).TrimStart('v')
  return [int]($version.Split('.')[0])
}

if ((Get-NodeMajor) -lt 22) {
  if (-not $Commit) {
    Write-Output 'Node 22 or later is missing. With --commit this installs it with winget.'
    exit 0
  }
  winget install --exact --silent `
    --accept-source-agreements --accept-package-agreements `
    --id OpenJS.NodeJS.LTS
  Update-Path
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  if (-not $Commit) {
    Write-Output 'pnpm is missing. With --commit this switches it on through corepack.'
    exit 0
  }
  corepack enable
  corepack prepare "pnpm@$PnpmVersion" --activate
  Update-Path
}

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  if (-not $Commit) {
    Write-Output "The workspace's packages are missing. With --commit this runs pnpm install in $Root."
    exit 0
  }
  pnpm --dir $Root install
}

if (-not (Test-Path (Join-Path $Root 'host\line.js'))) {
  if (-not $Commit) {
    Write-Output "The Term CLI is not built. With --commit this runs pnpm run make:line in $Root."
    exit 0
  }
  pnpm --dir $Root run make:line
}

Set-Location $Root
$env:TERM_DEV_ROOT = "$Root"
& node (Join-Path $Root 'host\line.js') boot (Join-Path $Here 'base.tree') -- @args
exit $LASTEXITCODE
