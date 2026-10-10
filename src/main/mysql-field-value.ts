/** Format a MySQL value for the table viewer without losing binary type information. */
export function formatMysqlCell(
  value: unknown,
  field?: { columnType?: number; columnLength?: number }
): string | null {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) {
    // MySQL BIT(1) (protocol type 16, length 1) arrives as a one-byte Buffer.
    if (field?.columnType === 16 && field.columnLength === 1 && value.length === 1) {
      return String(value[0] & 1)
    }
    return '<' + value.length + ' bytes>'
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
