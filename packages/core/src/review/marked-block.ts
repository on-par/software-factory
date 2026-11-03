export interface BlockMarkers {
  start: string;
  end: string;
}

function blockEnd(text: string, start: number, markers: BlockMarkers): number {
  const end = text.indexOf(markers.end, start + markers.start.length);
  return end === -1 ? text.length : end + markers.end.length;
}

export function upsertMarkedBlock(body: string | null | undefined, block: string, markers: BlockMarkers): string {
  const current = body ?? '';
  const first = current.indexOf(markers.start);
  if (first === -1) {
    return current.trim() === '' ? block : `${current.trimEnd()}\n\n${block}\n`;
  }
  const head = current.slice(0, first);
  let tail = current.slice(blockEnd(current, first, markers));
  let next = tail.indexOf(markers.start);
  while (next !== -1) {
    const before = tail.slice(0, next).trimEnd();
    const after = tail.slice(blockEnd(tail, next, markers)).trimStart();
    tail = before !== '' && after !== '' ? `${before}\n\n${after}` : `${before}${after}`;
    next = tail.indexOf(markers.start);
  }
  return `${head}${block}${tail}`;
}
