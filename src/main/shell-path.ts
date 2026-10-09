/** PowerShell 5.1-compatible refresh, scoped to the child process's PATH only. */
export const WINDOWS_PATH_REFRESH_FUNCTION = String.raw`function Update-CTProcessPath {
  param(
    [AllowNull()][AllowEmptyString()][string]$MachinePath,
    [AllowNull()][AllowEmptyString()][string]$UserPath
  )
  try {
    if (-not $PSBoundParameters.ContainsKey('MachinePath')) { $MachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine') }
    if (-not $PSBoundParameters.ContainsKey('UserPath')) { $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User') }
    if ([string]::IsNullOrWhiteSpace($MachinePath) -and [string]::IsNullOrWhiteSpace($UserPath)) { return }
    $ctInheritedPath = [Environment]::GetEnvironmentVariable('Path', 'Process')
    $ctSeenPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $ctPathParts = [Collections.Generic.List[string]]::new()
    foreach ($ctPathBucket in @($ctInheritedPath, $MachinePath, $UserPath)) {
      $ctExpandedBucket = [Environment]::ExpandEnvironmentVariables([string]$ctPathBucket)
      foreach ($ctRawPathPart in ($ctExpandedBucket -split ';')) {
        $ctPathPart = $ctRawPathPart.Trim().Trim('"')
        if ([string]::IsNullOrWhiteSpace($ctPathPart)) { continue }
        $ctPathKey = $ctPathPart
        # Normalize trailing separators without treating a drive root as a drive-relative path.
        $ctRootLength = $ctPathPart.Length
        try { $ctRootLength = [IO.Path]::GetPathRoot($ctPathPart).Length } catch { }
        if ($ctPathPart.Length -gt $ctRootLength) {
          $ctPathKey = $ctPathPart.TrimEnd([char[]]'\/')
        }
        if ($ctSeenPaths.Add($ctPathKey)) { $ctPathParts.Add($ctPathPart) }
      }
    }
    if ($ctPathParts.Count -gt 0) {
      [Environment]::SetEnvironmentVariable('Path', ($ctPathParts -join ';'), 'Process')
    }
  } catch {
    # Keep the inherited PATH if reading or preparing registered paths fails.
  }
}`

// Preserve launcher-specific tools first, then add new paths registered after it started.
// This runs before the terminal announces readiness, including after a reset or reconnect.
export const WINDOWS_PATH_REFRESH_SCRIPT = `${WINDOWS_PATH_REFRESH_FUNCTION}\nUpdate-CTProcessPath`
