/**
 * Test helper: a multipart POST serialised by hand. Bun's in-process `Request(FormData)` shortcut
 * re-sniffs each part's content type from its bytes instead of honouring the declared one, so a
 * "wrong mime" test only behaves like a real client when the Content-Type travels on the wire.
 */
export function multipartRequest(
  url: string,
  fields: Record<string, string>,
  file?: { bytes: Uint8Array; type: string },
): Request {
  const boundary = '----imagegatewaytest'
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    )
  }
  if (file) {
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="in"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      file.bytes,
      enc.encode('\r\n'),
    )
  }
  parts.push(enc.encode(`--${boundary}--\r\n`))
  return new Request(url, {
    method: 'POST',
    body: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  })
}
