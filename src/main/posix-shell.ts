/** macOS ships zsh; other local POSIX systems use sh without an extra dependency. */
export function localPosixShellPath(platform = process.platform): string {
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

/**
 * A persistent, non-interactive login shell. Each UTF-8 command arrives as one
 * base64 line. eval runs in this shell so variables, functions and cwd survive;
 * commands read /dev/null so they cannot consume the next protocol message.
 */
export function buildPosixWrapper(token: string, platform = process.platform): string {
  const decodeFlag = platform === 'darwin' ? '-D' : '-d'
  return [
    // Keep stderr ahead of the completion marker in the same pipe.
    'exec 2>&1',
    // Login profiles may cd; the selected directory still owns this session.
    'if [ "$#" -gt 0 ]; then cd -- "$1" || exit 1; fi',
    '__ct_seq=0',
    `printf '\\n__CT_READY_${token}__\\n'`,
    'while IFS= read -r __ct_line; do',
    '  [ -n "$__ct_line" ] || continue',
    '  __ct_seq=$((__ct_seq + 1))',
    `  __ct_script=$(printf '%s' "$__ct_line" | /usr/bin/base64 ${decodeFlag})`,
    // A failed command must still reach its completion report with errexit set.
    '  if eval "$__ct_script" </dev/null; then __ct_code=0; else __ct_code=$?; fi',
    // Separate a command's final unterminated line from the protocol marker.
    // Encode cwd too: POSIX names can contain the protocol's line delimiters.
    '  __ct_cwd=$(printf \'%s\' "$PWD" | /usr/bin/base64 | /usr/bin/tr -d \'\\r\\n\')',
    `  printf '\\n__CT_DONE_${token}_%s__ %s %s\\n' "$__ct_seq" "$__ct_code" "$__ct_cwd"`,
    'done'
  ].join('\n')
}
