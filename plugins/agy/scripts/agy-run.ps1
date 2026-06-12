<#
  agy-run.ps1 - native Windows PowerShell entry for the read-only synchronous
  /agy:* commands (ask, scrape, doc-to-md), for users without git-bash.

  Mirrors agy-run.sh's read-only model: agy runs FROM a throwaway temp dir
  (never your repo), output is captured from agy's own transcript via
  lib/transcript.mjs, and inputs are validated by lib/inputguard.mjs (URL
  SSRF guard / file path deny-list). The Node companion (agy-companion.mjs)
  still handles the stateful commands (rescue/status/result/cancel, branch
  review, adversarial). The Bash wrapper remains the primary path where bash
  is available; this is the fallback for native Windows PowerShell.

  Requires: agy on PATH (or %LOCALAPPDATA%\agy\bin\agy.exe) and node on PATH.
  Compatible with Windows PowerShell 5.1.
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:LibDir = Join-Path $PSScriptRoot 'lib'

function Find-Agy {
  $cmd = Get-Command agy -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if ($env:LOCALAPPDATA) {
    $cand = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
    if (Test-Path -LiteralPath $cand) { return $cand }
  }
  return $null
}

function Assert-Node {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('error: this command needs Node.js (input validation + output capture).')
    exit 1
  }
}

function Get-Timeout {
  param([string]$EnvVar, [string]$Default)
  $v = [Environment]::GetEnvironmentVariable($EnvVar)
  if ($v) { return $v }
  return $Default
}

# Run a Node helper as a separate process (Start-Process) with stdout/stderr
# redirected to files. Avoids PowerShell wrapping a native command's stderr in
# a NativeCommandError (which, under ErrorActionPreference='Stop', throws even
# with 2> redirection). Returns an object with Code / Out / Err.
function Get-NodeResult {
  param([Parameter(Mandatory = $true)][string]$Script, [string[]]$NodeArgs = @())
  $outF = [System.IO.Path]::GetTempFileName()
  $errF = [System.IO.Path]::GetTempFileName()
  try {
    $argList = @($Script) + $NodeArgs
    $proc = Start-Process -FilePath 'node' -ArgumentList $argList -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outF -RedirectStandardError $errF
    $out = Get-Content -Raw -LiteralPath $outF -ErrorAction SilentlyContinue
    $err = Get-Content -Raw -LiteralPath $errF -ErrorAction SilentlyContinue
    $o = ''; if ($out) { $o = $out.Trim() }
    $e = ''; if ($err) { $e = $err.Trim() }
    return [pscustomobject]@{ Code = $proc.ExitCode; Out = $o; Err = $e }
  } finally {
    Remove-Item -LiteralPath $outF, $errF -Force -ErrorAction SilentlyContinue
  }
}

# Run agy read-only from a throwaway temp dir and return its answer (captured
# from the transcript). Writes the answer to the pipeline on success; throws
# (exit 1) if nothing could be recovered.
function Invoke-AgyCapture {
  param(
    [Parameter(Mandatory = $true)][string]$Agy,
    [Parameter(Mandatory = $true)][string]$Timeout,
    [Parameter(Mandatory = $true)][string]$Prompt,
    [string]$StageFile
  )
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('agy-' + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    if ($StageFile) {
      Copy-Item -LiteralPath $StageFile -Destination $tmp -Force
    }
    $log = Join-Path $tmp 'agy-run.log'

    # Run agy FROM the temp dir (read-only: the repo is never agy's cwd or in
    # --add-dir, so it has no path to write there - same model as 0.6.2).
    # Pipe $null to close stdin (dodges the #76 non-TTY hang); discard agy's
    # stdout (empty under #76) and stderr.
    Push-Location $tmp
    try {
      $null | & $Agy --sandbox --add-dir $tmp --log-file $log --print-timeout $Timeout --print $Prompt *> $null
    } finally {
      Pop-Location
    }

    $res = Get-NodeResult -Script (Join-Path $script:LibDir 'transcript.mjs') -NodeArgs @($log, $tmp)
    if ($res.Code -eq 0 -and $res.Out) {
      $res.Out
      return
    }
    [Console]::Error.WriteLine('error: agy returned no output. Could not recover an answer from agy''s transcript (issue #76 capture).')
    [Console]::Error.WriteLine('       The prompt may have timed out, or agy was interrupted.')
    exit 1
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Ask {
  param([string[]]$Rest)
  $prompt = if ($Rest.Count -ge 1) { $Rest[0] } else { '' }
  if (-not $prompt) { [Console]::Error.WriteLine('error: ask requires a prompt argument'); exit 64 }
  $agy = Find-Agy
  if (-not $agy) { [Console]::Error.WriteLine('error: agy not found. Run /agy:setup or install it.'); exit 127 }
  Assert-Node
  Invoke-AgyCapture -Agy $agy -Timeout (Get-Timeout 'AGY_ASK_TIMEOUT' '8m0s') -Prompt $prompt
}

function Invoke-Scrape {
  param([string[]]$Rest)
  $url = if ($Rest.Count -ge 1) { $Rest[0] } else { '' }
  if (-not $url) { [Console]::Error.WriteLine('error: scrape requires a URL argument (http/https)'); exit 64 }
  $agy = Find-Agy
  if (-not $agy) { [Console]::Error.WriteLine('error: agy not found. Run /agy:setup or install it.'); exit 127 }
  Assert-Node
  $g = Get-NodeResult -Script (Join-Path $script:LibDir 'inputguard.mjs') -NodeArgs @('scrape', $url)
  if ($g.Code -ne 0) { [Console]::Error.WriteLine("error: refusing to scrape this URL - $($g.Err)"); exit 65 }
  $safe = $g.Out
  $prompt = "Fetch the web page at the URL below and return its MAIN readable content as clean Markdown - preserve headings, lists, links, tables, and code blocks; drop nav/ads/boilerplate. Output ONLY the Markdown, no preamble.`n`nURL: $safe"
  Invoke-AgyCapture -Agy $agy -Timeout (Get-Timeout 'AGY_SCRAPE_TIMEOUT' '5m0s') -Prompt $prompt
}

function Invoke-DocToMd {
  param([string[]]$Rest)
  $inPath = if ($Rest.Count -ge 1) { $Rest[0] } else { '' }
  if (-not $inPath) { [Console]::Error.WriteLine('error: doc-to-md requires a file path'); exit 64 }
  $agy = Find-Agy
  if (-not $agy) { [Console]::Error.WriteLine('error: agy not found. Run /agy:setup or install it.'); exit 127 }
  Assert-Node
  $g = Get-NodeResult -Script (Join-Path $script:LibDir 'inputguard.mjs') -NodeArgs @('doc', $inPath, (Get-Location).Path)
  if ($g.Code -ne 0) { [Console]::Error.WriteLine("error: refusing to convert this file - $($g.Err)"); exit 65 }
  $real = $g.Out
  $base = [System.IO.Path]::GetFileName($real)
  $prompt = "Read the file named ""$base"" in your workspace and convert it to clean, well-structured Markdown. Preserve headings, lists, tables, links, and code blocks. Output ONLY the Markdown - no preamble, no commentary."
  Invoke-AgyCapture -Agy $agy -Timeout (Get-Timeout 'AGY_DOCTOMD_TIMEOUT' '8m0s') -Prompt $prompt -StageFile $real
}

function Show-Help {
  @'
agy-run.ps1 - native Windows PowerShell entry for the read-only /agy:* commands.

  agy-run.ps1 ask <prompt>          One-shot prompt; returns agy's answer.
  agy-run.ps1 scrape <url>          Fetch a web page (read-only) -> Markdown. SSRF-guarded.
  agy-run.ps1 doc-to-md <path>      Convert a local document -> Markdown (read-only, path-guarded).
  agy-run.ps1 help                  This help.

All three run agy from a throwaway temp dir (it can't touch your repo) and
capture output from agy's own transcript. For the stateful commands
(rescue/status/result/cancel, branch review, adversarial), use the Node
companion (agy-companion.mjs). Where bash is available, agy-run.sh is the
primary path; this script is the native-Windows fallback.
'@
}

# ---- dispatch ----
$sub = if ($args.Count -ge 1) { $args[0] } else { 'help' }
$rest = if ($args.Count -ge 2) { $args[1..($args.Count - 1)] } else { @() }

switch ($sub) {
  'ask'       { Invoke-Ask -Rest $rest }
  'scrape'    { Invoke-Scrape -Rest $rest }
  'doc-to-md' { Invoke-DocToMd -Rest $rest }
  'help'      { Show-Help }
  '-h'        { Show-Help }
  '--help'    { Show-Help }
  default {
    [Console]::Error.WriteLine("error: unknown subcommand '$sub'")
    Show-Help
    exit 64
  }
}
