import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const createCertificate = ({ authority = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-mask-cert-'))
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', key, '-out', cert,
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-addext', `basicConstraints=critical,CA:${authority ? 'TRUE' : 'FALSE'}`,
    ],
    { stdio: 'ignore' },
  )
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8').trim(), file: cert }
}
