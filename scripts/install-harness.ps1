param(
  [string]$HarnessPath,
  [string]$HarnessHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string]$WorkerHome,
  [ValidateSet('harness','hub')][string]$Role = 'harness'
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'dsh-agent-hub') { throw 'Use the complete Agent Hub Harness package.' }
if (-not $HarnessPath) {
  $candidates = @('C:\DSH\DeepSeek Harness.exe', (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'), (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'))
  $HarnessPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $HarnessPath -or -not (Test-Path -LiteralPath $HarnessPath)) { throw 'Specify -HarnessPath with the installed DeepSeek Harness.exe.' }
$cli = Join-Path (Split-Path $HarnessPath -Parent) 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $HarnessPath -Parent) 'resources\runtime\cli\bin\dsh.cmd'))) { throw 'The installed Harness has no desktop plugin CLI.' }
$HarnessHome = [IO.Path]::GetFullPath($HarnessHome)
$profile = Join-Path $HarnessHome 'profiles\desktop'
$profileManifest = Join-Path $profile 'package.json'
if (-not (Test-Path -LiteralPath $profileManifest)) { throw 'Open Harness once to initialize the desktop profile.' }
$dataRoot = Join-Path $HarnessHome 'agent-hub'
$legacyData = Join-Path $HarnessHome 'agent-hub-v2'
if (-not ((Test-Path -LiteralPath (Join-Path $dataRoot 'config.json')) -or (Test-Path -LiteralPath (Join-Path $dataRoot 'plugin-settings.json'))) -and ((Test-Path -LiteralPath (Join-Path $legacyData 'config.json')) -or (Test-Path -LiteralPath (Join-Path $legacyData 'plugin-settings.json')))) { $dataRoot = $legacyData }
$settingsPath = Join-Path $dataRoot 'plugin-settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath) { Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$patch = Join-Path $profile 'cordis.patch.yml'
$oldPatch = if (Test-Path -LiteralPath $patch) { [IO.File]::ReadAllText($patch) } else { '' }
if (-not $PSBoundParameters.ContainsKey('Role') -and ($settings.role -eq 'hub' -or $oldPatch -match '(?m)^\s+role:\s*hub\s*$')) { $Role = 'hub' }
if (-not $WorkerHome) {
  $WorkerHome = Join-Path $dataRoot 'worker'
  foreach ($candidate in @($settings.workerHome, (Join-Path $env:USERPROFILE '.agent-hub-worker'))) {
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'config.json'))) {
      $saved = Get-Content -LiteralPath (Join-Path $candidate 'config.json') -Raw | ConvertFrom-Json
      if ($saved.runtimes -contains 'harness') { $WorkerHome = $candidate; break }
    }
  }
}
$WorkerHome = [IO.Path]::GetFullPath($WorkerHome)
if ($Role -eq 'harness' -and (Test-Path -LiteralPath (Join-Path $WorkerHome 'config.json')) -and -not ((Get-Content -LiteralPath (Join-Path $WorkerHome 'config.json') -Raw | ConvertFrom-Json).runtimes -contains 'harness')) { throw 'This directory belongs to a retired standalone worker. Choose a separate Harness WorkerHome; its credentials and data were not changed.' }
$previousDshHome = $env:DSH_HOME
$previousNodeMode = $env:ELECTRON_RUN_AS_NODE
$backup = Join-Path $HarnessHome ('agent-hub-install-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$plugins = [IO.Path]::GetFullPath((Join-Path $HarnessHome 'plugins'))
$target = [IO.Path]::GetFullPath((Join-Path $plugins 'dsh-agent-hub'))
if ((Split-Path $target -Parent) -ne $plugins -or (Split-Path $target -Leaf) -ne 'dsh-agent-hub') { throw 'Invalid plugin installation target.' }
$stage = Join-Path $plugins ('.agent-hub-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($name in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) { $path = Join-Path $profile $name; if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination (Join-Path $backup $name) } }
if (Test-Path -LiteralPath $settingsPath) { Copy-Item -LiteralPath $settingsPath -Destination (Join-Path $backup 'plugin-settings.json') }
try {
  $env:ELECTRON_RUN_AS_NODE = '1'; $env:DSH_HOME = $HarnessHome
  $nodeMajor = (& $HarnessPath --expose-internals -p 'parseInt(process.versions.node)' | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [int]($nodeMajor | Select-Object -Last 1) -lt 24) { throw 'This plugin requires Harness with bundled Node 24 or later.' }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  foreach ($item in @($manifest.files) + @('package.json')) { Copy-Item -LiteralPath (Join-Path $sourceRoot $item) -Destination $stage -Recurse }
  New-Item -ItemType Directory -Path (Join-Path $stage 'node_modules') | Out-Null
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'node_modules\ws') -Destination (Join-Path $stage 'node_modules\ws') -Recurse
  # Disable only this plugin during replacement; retain all other plugins and settings.
  [IO.File]::WriteAllText($patch, ($oldPatch.TrimEnd() + "`n- id: agent-hub-v2`n  disabled: true`n- id: agent-hub`n  disabled: true`n"), [Text.UTF8Encoding]::new($false))
  Start-Sleep -Seconds 2
  if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination (Join-Path $backup 'plugin') }
  Move-Item -LiteralPath $stage -Destination $target
  $profileJson = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
  $profileJson.dependencies.PSObject.Properties.Remove('dsh-agent-hub-v2')
  if ($profileJson.dsh.profile.bundles) { $profileJson.dsh.profile.bundles = @($profileJson.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-agent-hub-v2' }) }
  [IO.File]::WriteAllText($profileManifest, ($profileJson | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
  & $HarnessPath --expose-internals $cli plugin --profile desktop add ('link:' + $target.Replace('\','/')) --ignore-scripts | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Harness plugin registration failed.' }
  $text = [regex]::Replace($oldPatch, '(?m)^([ \t]*(?:-[ \t]*)?(?:id|name):[ \t]*[''"]?)(dsh-)?agent-hub-v2([''"]?[ \t]*)$', '${1}${2}agent-hub${3}')
  $text = $text.Replace('Agent Hub v2','Agent Hub')
  $text = [regex]::Replace($text, '(?ms)^# BEGIN Agent Hub installer role\r?\n.*?^# END Agent Hub installer role\r?\n?', '')
  # Cordis replaces a config object instead of deeply merging repeated config patches.
  # Role and WorkerHome live in plugin-settings; keep existing listener/TLS config intact.
  $text = $text.TrimEnd() + "`n`n# BEGIN Agent Hub installer role`n- id: agent-hub`n  disabled: false`n# END Agent Hub installer role`n"
  $settings | Add-Member -NotePropertyName role -NotePropertyValue $Role -Force
  $settings | Add-Member -NotePropertyName workerHome -NotePropertyValue $WorkerHome -Force
  New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
  [IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($patch, $text, [Text.UTF8Encoding]::new($false))
} catch {
  foreach ($name in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) { if (Test-Path -LiteralPath (Join-Path $backup $name)) { Copy-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $profile $name) -Force } }
  if (Test-Path -LiteralPath (Join-Path $backup 'plugin-settings.json')) { Copy-Item -LiteralPath (Join-Path $backup 'plugin-settings.json') -Destination $settingsPath -Force }
  if (Test-Path -LiteralPath (Join-Path $backup 'plugin')) {
    $failed = Join-Path $plugins ('.agent-hub-failed-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $failed }
    Move-Item -LiteralPath (Join-Path $backup 'plugin') -Destination $target
  }
  throw
} finally { $env:DSH_HOME = $previousDshHome; $env:ELECTRON_RUN_AS_NODE = $previousNodeMode }
Write-Output ('Agent Hub latest installed; role: ' + $Role + '. Open Settings > Agent Hub devices. Starts automatically with Harness.')
Write-Output ('Profile backup: ' + $backup)
