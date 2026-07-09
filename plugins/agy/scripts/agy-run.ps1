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

# Quote a single argument per the Windows CommandLineToArgvW rules, so paths
# with spaces (or embedded quotes) survive intact. PowerShell 5.1's
# Start-Process -ArgumentList joins an array with naive quoting and SPLITS
# spaced paths — an argument-injection / validation-bypass vector — so we
# build the command line ourselves and launch via System.Diagnostics.Process.
function ConvertTo-NativeArg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  $s = $a -replace '(\\*)"', '$1$1\"'   # double backslashes before a quote, escape the quote
  $s = $s -replace '(\\+)$', '$1$1'     # double a trailing backslash run (precedes the closing quote)
  return '"' + $s + '"'
}

# Run a Node helper as a child process with stdout/stderr captured. Avoids
# PowerShell wrapping a native command's stderr in a NativeCommandError (which
# throws under ErrorActionPreference='Stop') AND the Start-Process arg-splitting
# bug. Returns an object with Code / Out / Err.
function Get-NodeResult {
  param([Parameter(Mandatory = $true)][string]$Script, [string[]]$NodeArgs = @())
  $all = @($Script) + $NodeArgs
  $argStr = ($all | ForEach-Object { ConvertTo-NativeArg $_ }) -join ' '
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'node'
  $psi.Arguments = $argStr
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  # Read stderr async to avoid a pipe-buffer deadlock when stdout is large.
  $errTask = $proc.StandardError.ReadToEndAsync()
  $out = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  $err = $errTask.Result
  $o = ''; if ($out) { $o = $out.Trim() }
  $e = ''; if ($err) { $e = $err.Trim() }
  return [pscustomobject]@{ Code = $proc.ExitCode; Out = $o; Err = $e }
}

# Run agy read-only from a throwaway temp dir and return its answer (captured
# from the transcript). Writes the answer to the pipeline on success; throws
# (exit 1) if nothing could be recovered.
function Invoke-AgyCapture {
  param(
    [Parameter(Mandatory = $true)][string]$Agy,
    [Parameter(Mandatory = $true)][string]$Timeout,
    [Parameter(Mandatory = $true)][string]$Prompt,
    [string]$StageFile,
    [string]$StageAs = 'document'
  )
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('agy-' + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    if ($StageFile) {
      # Stage via the Node helper (lstat + copy in one step, TOCTOU-resistant)
      # under a fixed name, rather than Copy-Item which re-follows the path.
      $dest = Join-Path $tmp $StageAs
      $sg = Get-NodeResult -Script (Join-Path $script:LibDir 'inputguard.mjs') -NodeArgs @('stage', $StageFile, $dest)
      if ($sg.Code -ne 0) {
        [Console]::Error.WriteLine("error: could not stage the input file - $($sg.Err)")
        exit 1
      }
    }
    $log = Join-Path $tmp 'agy-run.log'

    # Run agy FROM the temp dir (read-only: the repo is never agy's cwd or in
    # --add-dir, so it has no path to write there - same model as 0.6.2).
    # Pipe $null to close stdin (dodges the #76 non-TTY hang); discard agy's
    # stdout (empty under #76) and stderr.
    # Strip repo-location hints (CLAUDE_PROJECT_DIR / GIT_*) from agy's env as
    # defense in depth, so it can't target the host repo by absolute path.
    $stripVars = @('CLAUDE_PROJECT_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR')
    $savedEnv = @{}
    foreach ($v in $stripVars) {
      $savedEnv[$v] = [Environment]::GetEnvironmentVariable($v)
      if ($null -ne $savedEnv[$v]) { Remove-Item -Path "Env:\$v" -ErrorAction SilentlyContinue }
    }
    $stdoutFile = Join-Path $tmp 'agy-stdout.txt'
    Push-Location $tmp
    try {
      $null | & $Agy --sandbox --add-dir $tmp --log-file $log --print-timeout $Timeout --print $Prompt 1> $stdoutFile 2> $null
    } finally {
      Pop-Location
      foreach ($v in $stripVars) {
        if ($null -ne $savedEnv[$v]) { Set-Item -Path "Env:\$v" -Value $savedEnv[$v] }
      }
    }

    # Prefer agy's direct stdout (agy >= 1.0.15 fixed the #76 bug that swallowed
    # it); fall back to reading agy's own transcript for older agy.
    $answer = Get-Content -Raw -LiteralPath $stdoutFile -ErrorAction SilentlyContinue
    if ($answer) { $answer = $answer.Trim() }
    if (-not $answer) {
      $res = Get-NodeResult -Script (Join-Path $script:LibDir 'transcript.mjs') -NodeArgs @($log, $tmp)
      if ($res.Code -eq 0 -and $res.Out) { $answer = $res.Out }
    }
    if ($answer) {
      $answer
      return
    }
    [Console]::Error.WriteLine('error: agy returned no output — neither stdout nor the transcript produced an answer.')
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
  # Fixed staged name derived only from the validated extension — the
  # untrusted original filename is never put in the prompt (injection guard).
  $ext = [System.IO.Path]::GetExtension($real).TrimStart('.').ToLower()
  $staged = "document.$ext"
  $prompt = "Read the file named ""$staged"" in your workspace and convert it to clean, well-structured Markdown. Preserve headings, lists, tables, links, and code blocks. Output ONLY the Markdown - no preamble, no commentary."
  Invoke-AgyCapture -Agy $agy -Timeout (Get-Timeout 'AGY_DOCTOMD_TIMEOUT' '8m0s') -Prompt $prompt -StageFile $real -StageAs $staged
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
