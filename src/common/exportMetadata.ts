/** ffmetadata uses backslash escaping, including literal line breaks. */
export function escapeFfmetadata(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll(/([=;#\n])/g, '\\$1');
}

export function serializeDispositions(disposition: Record<string, number> | undefined) {
  return Object.entries(disposition ?? {}).filter(([, value]) => value === 1).map(([key]) => key).join('+') || '0';
}

export function getProcessStderr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return '';
}

export function isExpectedAttachmentExit(exitCode: unknown, stderr: unknown) {
  return exitCode === 1 && getProcessStderr(stderr).trim() === 'At least one output file must be specified';
}
