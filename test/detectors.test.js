import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDetector } from '../src/detectors.js'

const found = (text, dictionary = [], publicDomains = ['example.org', 'w3.org', 'github.com']) =>
  createDetector({ dictionary, publicDomains })(text)
    .map(({ value, category }) => ({ value, category }))
    .sort((a, b) => text.indexOf(a.value) - text.indexOf(b.value))

const detected = [
  ['email address', 'contact a.user@corp.example now', [{ value: 'a.user@corp.example', category: 'EMAIL' }]],
  [
    'private key block',
    'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9\n-----END RSA PRIVATE KEY-----\ndone',
    [{ value: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9\n-----END RSA PRIVATE KEY-----', category: 'KEY' }],
  ],
  [
    'json web token',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk end',
    [{ value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', category: 'TOKEN' }],
  ],
  ['gitlab token', 'use glpat-abcdefghij0123456789 here', [{ value: 'glpat-abcdefghij0123456789', category: 'TOKEN' }]],
  ['github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', [{ value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', category: 'TOKEN' }]],
  ['anthropic key', 'sk-ant-api03-abcdefghijklmnop_qrstuv-0123', [{ value: 'sk-ant-api03-abcdefghijklmnop_qrstuv-0123', category: 'TOKEN' }]],
  ['aws access key id', 'id AKIAIOSFODNN7EXAMPLE ok', [{ value: 'AKIAIOSFODNN7EXAMPLE', category: 'TOKEN' }]],
  ['slack token', 'xoxb-123456789012-abcdefghijkl', [{ value: 'xoxb-123456789012-abcdefghijkl', category: 'TOKEN' }]],
  [
    'bearer header keeps the scheme visible',
    'Authorization: Bearer abcdef0123456789abcdef',
    [{ value: 'abcdef0123456789abcdef', category: 'SECRET' }],
  ],
  ['env style assignment', 'DB_PASSWORD=hunter2hunter', [{ value: 'hunter2hunter', category: 'SECRET' }]],
  ['env style assignment with quotes', 'export API_KEY="abc123def456"', [{ value: 'abc123def456', category: 'SECRET' }]],
  ['env assignment in front of a command', 'DB_PASSWORD=hunter2hunter npm start', [{ value: 'hunter2hunter', category: 'SECRET' }]],
  ['env assignment passed as an argument', 'docker run -e API_TOKEN=abc123def456 image', [{ value: 'abc123def456', category: 'SECRET' }]],
  ['quoted literal on a secret property',"password: 'hunter2hunter',", [{ value: 'hunter2hunter', category: 'SECRET' }]],
  ['quoted literal on a secret variable', 'const authToken = "abc123def456"', [{ value: 'abc123def456', category: 'SECRET' }]],
  ['quoted literal on a json key', '{"client_secret": "abc123def456"}', [{ value: 'abc123def456', category: 'SECRET' }]],
  ['credentials inside a url', 'git clone https://deploy:s3cretpass@git.example.org/repo.git', [{ value: 'deploy:s3cretpass', category: 'SECRET' }]],
  ['ipv4 address with port', 'connect to 10.20.30.40:5060', [{ value: '10.20.30.40', category: 'IP' }]],
  ['ipv4 address in a url', 'ws://192.168.1.15/ws', [{ value: '192.168.1.15', category: 'IP' }]],
  ['phone with spaces', 'call +7 701 123 45 67 today', [{ value: '+7 701 123 45 67', category: 'PHONE' }]],
  ['phone compact', 'call +77011234567 today', [{ value: '+77011234567', category: 'PHONE' }]],
  ['phone with trunk prefix', 'call 8 (701) 123-45-67 today', [{ value: '8 (701) 123-45-67', category: 'PHONE' }]],
  ['phone with trunk prefix compact', 'call 87011234567 today', [{ value: '87011234567', category: 'PHONE' }]],
  ['international phone', 'from +12025550123', [{ value: '+12025550123', category: 'PHONE' }]],
  ['host of a web address', 'GET https://billing.internal-site.kz/api/v1 failed', [{ value: 'billing.internal-site.kz', category: 'HOST' }]],
  ['host of a web address with a port, leaving the port readable', 'origin https://portal.corp.kz:8443', [{ value: 'portal.corp.kz', category: 'HOST' }]],
  ['host of a socket address made of a single name', 'connect wss://pbx01:8089/ws', [{ value: 'pbx01', category: 'HOST' }]],
  ['host of a database address after credentials', 'postgres://deploy:s3cretpass@db.corp.kz:5432/app', [{ value: 'deploy:s3cretpass', category: 'SECRET' }, { value: 'db.corp.kz', category: 'HOST' }]],
  ['host written in capitals', 'open HTTPS://PORTAL.CORP.KZ/x', [{ value: 'PORTAL.CORP.KZ', category: 'HOST' }]],
  ['host with an unknown ending when it follows a scheme', 'see http://wiki.dept.zone/page', [{ value: 'wiki.dept.zone', category: 'HOST' }]],
  ['domain name standing alone', 'open gitlab.corp.kz now', [{ value: 'gitlab.corp.kz', category: 'HOST' }]],
  ['domain name of two parts', 'owned by somecompany.com since', [{ value: 'somecompany.com', category: 'HOST' }]],
  ['domain name of three parts with a country ending', 'served from shop.company.de today', [{ value: 'shop.company.de', category: 'HOST' }]],
  ['domain name of two parts ending in kz', 'owned by somecompany.kz since', [{ value: 'somecompany.kz', category: 'HOST' }]],
  ['domain name at the end of a sentence', 'deployed to api.service.local.', [{ value: 'api.service.local', category: 'HOST' }]],
  ['domain name in a git remote', 'git@gitlab.corp.kz:group/repo.git', [{ value: 'gitlab.corp.kz', category: 'HOST' }]],
  ['domain name in quotes', "baseURL: 'api.corp.kz',", [{ value: 'api.corp.kz', category: 'HOST' }]],
  ['individual identification number', 'iin 900101300007 ok', [{ value: '900101300007', category: 'IIN' }]],
  ['card number with spaces', 'card 4111 1111 1111 1111 ok', [{ value: '4111 1111 1111 1111', category: 'CARD' }]],
  ['card number compact', 'card 4111111111111111 ok', [{ value: '4111111111111111', category: 'CARD' }]],
]

for (const [name, text, want] of detected) {
  test(`detects ${name}`, () => assert.deepEqual(found(text), want))
}

const ignored = [
  ['typescript type annotation', 'password: string'],
  ['method call on an object', 'console.log(value)'],
  ['property of this', 'this.value = this.net'],
  ['translation table keyed by language', 'return messages.ru || locale.kz || i18n.tr'],
  ['property that reads like a domain ending', 'user.name, error.info, item.id, window.location.host'],
  ['method that reads like a domain ending', 'list.at(0) + moment.de(1)'],
  ['property named like a country ending', 'incomingCall(booted.ua) + theme.bg + sort.by + tls.ca + rect.pt + names.de + time.am'],
  ['property chain named like a country ending', 'harness.booted.ua, colors.theme.bg, query.sort.by'],
  ['source file names', 'README.md package.json vite.config.ts script.sh index.html main.rs'],
  ['dotenv file names', 'cp .env.local .env.production && cat settings.local.json'],
  ['package version', 'vue@3.4.21 and jssip-vue@1.1.14-demo.0'],
  ['web address built from a variable', 'fetch(`https://${host}/api`) and "http://{{host}}/x"'],
  ['web address of this machine', 'open http://localhost:3000/x and http://127.0.0.1:8080/y'],
  ['public web address from the allowed list', 'clone https://github.com/org/repo and see https://docs.github.com/x'],
  ['namespace of a vector image', '<svg xmlns="http://www.w3.org/2000/svg">'],
  ['public domain name from the allowed list standing alone', 'mirror of github.com'],
  ['function call assigned to a secret name', 'const token = getToken()'],
  ['property access assigned to a secret name', 'const password = props.password'],
  ['short quoted literal', "token: 'abc'"],
  ['uppercase constant assigned from an expression', 'API_TOKEN = os.environ["KEY"]'],
  ['loopback address', 'listen on 127.0.0.1'],
  ['wildcard address', 'bind 0.0.0.0'],
  ['browser version in a user agent', 'Chrome/120.0.0.0 Safari'],
  ['octet above 255', 'value 300.1.2.3'],
  ['three part version', 'bump 1.1.14'],
  ['short number', 'ticket 1234567'],
  ['millisecond timestamp', 'at 1700000000000 ms'],
  ['twelve digits with a wrong check digit', 'id 900101300008'],
  ['twelve digits with an impossible month', 'id 901301300007'],
  ['sixteen digits failing the luhn check', 'id 4111111111111112'],
]

for (const [name, text] of ignored) {
  test(`ignores ${name}`, () => assert.deepEqual(found(text), []))
}

test('dictionary term matches in any letter case and keeps the original spelling', () => {
  assert.deepEqual(found('Deploy to ACME then acme', ['acme']), [
    { value: 'ACME', category: 'TERM' },
    { value: 'acme', category: 'TERM' },
  ])
})

test('dictionary term matches inside a longer word', () => {
  assert.deepEqual(found('acmebank', ['acme']), [{ value: 'acme', category: 'TERM' }])
})

test('dictionary term with regex characters is matched literally', () => {
  assert.deepEqual(found('a+b and aab', ['a+b']), [{ value: 'a+b', category: 'TERM' }])
})

test('dictionary ignores blank lines, comments and terms shorter than three characters', () => {
  assert.deepEqual(found('ab # note', ['', '   ', '# note', 'ab']), [])
})

test('dictionary domain matches the domain and every subdomain', () => {
  assert.deepEqual(found('corp.example gitlab.corp.example a.b.Corp.Example', ['domain:corp.example']), [
    { value: 'corp.example', category: 'HOST' },
    { value: 'gitlab.corp.example', category: 'HOST' },
    { value: 'a.b.Corp.Example', category: 'HOST' },
  ])
})

test('dictionary domain matches before sentence punctuation', () => {
  assert.deepEqual(found('see gitlab.corp.example.', ['domain:corp.example']), [
    { value: 'gitlab.corp.example', category: 'HOST' },
  ])
})

test('dictionary domain does not match a different domain sharing its text', () => {
  assert.deepEqual(found('notcorp.example corp.example.org corp.examples', ['domain:corp.example']), [])
})

test('nothing is public when the allowed list is empty', () => {
  assert.deepEqual(found('clone https://github.com/org/repo', [], []), [{ value: 'github.com', category: 'HOST' }])
})

test('domain from the allowed list covers its subdomains but not look-alike names', () => {
  assert.deepEqual(found('https://api.github.com/x https://notgithub.com/y https://github.com.evil.kz/z'), [
    { value: 'notgithub.com', category: 'HOST' },
    { value: 'github.com.evil.kz', category: 'HOST' },
  ])
})

test('dictionary domain still wins for names that would otherwise be public', () => {
  assert.deepEqual(found('https://internal.github.com/x', ['domain:internal.github.com']), [
    { value: 'internal.github.com', category: 'HOST' },
  ])
})

test('dictionary regex matches with a custom category', () => {
  assert.deepEqual(found('agent operator_12345 online', ['regex:operator_\\d{5}']), [
    { value: 'operator_12345', category: 'CUSTOM' },
  ])
})

test('broken dictionary pattern is reported by its position without repeating it', () => {
  assert.throws(
    () => createDetector({ dictionary: ['acme', 'regex:operator_(\\d{5}'] }),
    (error) => /dictionary entry 2 is not a valid pattern/.test(error.message) && !error.message.includes('operator_'),
  )
})

test('match positions point at the value inside the text', () => {
  const text = 'DB_PASSWORD=hunter2hunter'
  const [match] = createDetector({ dictionary: [] })(text)
  assert.equal(text.slice(match.start, match.end), 'hunter2hunter')
})
