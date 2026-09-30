import { OperationError } from './operations';
/** Enforce the limit even for chunked requests without Content-Length. */
export async function boundedBody(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get('content-length')) > maxBytes) throw new OperationError('invalid_request', 'Request body too large');
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new OperationError('invalid_request', 'Request body too large'); } chunks.push(value); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
