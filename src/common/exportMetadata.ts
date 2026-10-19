/** ffmetadata uses backslash escaping, including literal line breaks. */
export function escapeFfmetadata(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll(/([=;#\n])/g, String.raw`\$1`);
}

export function serializeDispositions(disposition: object | undefined) {
  return Object.entries(disposition ?? {}).filter(([, value]) => value === 1).map(([key]) => key).join('+') || '0';
}

export function getProcessStderr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    const Decoder = Reflect.get(globalThis, 'TextDecoder') as new () => { decode: (input: Uint8Array) => string };
    return new Decoder().decode(value);
  }
  return '';
}

export function isExpectedAttachmentExit(exitCode: unknown, stderr: unknown) {
  return exitCode === 1 && getProcessStderr(stderr).trim() === 'At least one output file must be specified';
}

/** Provenance is retained even when other global metadata is intentionally stripped. */
export function getProvenanceMetadataArgs(tags: object | undefined) {
  const values = Object.fromEntries(Object.entries(tags ?? {}).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key.toLowerCase(), value as string]));
  const marker = values['stash_compression'];
  let comment = values['comment'] ?? '';
  if (!marker && !comment.includes('STASH-COMPRESSION:v1:')) return [];
  if (marker && !comment.includes('STASH-COMPRESSION:v1:')) {
    try {
      const parsed = JSON.parse(marker) as { id?: unknown, profile?: unknown };
      if (typeof parsed.id === 'string' && typeof parsed.profile === 'string') comment += `${comment ? '\n' : ''}STASH-COMPRESSION:v1:${parsed.id}:${parsed.profile}`;
    } catch { /* Preserve an unrecognized marker for provenance review. */ }
  }
  return [...(marker ? ['-metadata', `stash_compression=${marker}`] : []), ...(comment ? ['-metadata', `comment=${comment}`] : [])];
}

export function getMergedProvenanceMetadataArgs(groups: (object | undefined)[]) {
  const records = groups.map((tags) => getProvenanceMetadataArgs(tags));
  const primary = records.find((args) => args.some((value) => value.startsWith('stash_compression=')))?.find((value) => value.startsWith('stash_compression='));
  const comments = records.flatMap((args) => args.filter((value) => value.startsWith('comment=')).map((value) => value.slice('comment='.length)));
  return [...(primary ? ['-metadata', primary] : []), ...(comments.length > 0 ? ['-metadata', `comment=${[...new Set(comments)].join('\n')}`] : [])];
}
