import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDetector } from '../src/detectors.js'

const found = (text, dictionary = [], publicDomains = ['example.org', 'w3.org', 'github.com'], identities = {}) =>
  createDetector({ dictionary, publicDomains, identities })(text)
    .sort((a, b) => a.start - b.start)
    .map(({ value, category }) => ({ value, category }))

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
  ['login made of a name and five digits', 'agent operator_12345 is online', [{ value: 'operator_12345', category: 'LOGIN' }]],
  ['login in the path of a web address', 'wss://portal.corp.kz/api/ws-api/operator_12345/open', [{ value: 'portal.corp.kz', category: 'HOST' }, { value: 'operator_12345', category: 'LOGIN' }]],
  ['login as a quoted value', '{"user":"operator_12345"}', [{ value: 'operator_12345', category: 'LOGIN' }]],
  ['login as a query value', 'GET /report?agent=operator_12345&page=2', [{ value: 'operator_12345', category: 'LOGIN' }]],
  ['login named by its key', "username: 'jsmith',", [{ value: 'jsmith', category: 'LOGIN' }]],
  ['login named by a json key', '{"login": "ivanov.a", "page": 2}', [{ value: 'ivanov.a', category: 'LOGIN' }]],
  ['login assigned to a variable', 'const user = "a-petrov"', [{ value: 'a-petrov', category: 'LOGIN' }]],
  ['login named by a key with a separator', "user_name: 'jsmith', userLogin: 'kim.lee', user_id: 'u10293'", [{ value: 'jsmith', category: 'LOGIN' }, { value: 'kim.lee', category: 'LOGIN' }, { value: 'u10293', category: 'LOGIN' }]],
  ['login in an environment assignment', 'DB_USER=jsmith LOGIN=kim.lee npm start', [{ value: 'jsmith', category: 'LOGIN' }, { value: 'kim.lee', category: 'LOGIN' }]],
  ['login after a collection in a web address', 'GET https://portal.corp.kz/api/users/jsmith/settings', [{ value: 'portal.corp.kz', category: 'HOST' }, { value: 'jsmith', category: 'LOGIN' }]],
  ['login after another collection in a web address', 'wss://portal.corp.kz/agents/ivanov.a and https://portal.corp.kz/v2/accounts/kim_lee?x=1', [{ value: 'portal.corp.kz', category: 'HOST' }, { value: 'ivanov.a', category: 'LOGIN' }, { value: 'portal.corp.kz', category: 'HOST' }, { value: 'kim_lee', category: 'LOGIN' }]],
  ['login in the query of a web address', 'https://portal.corp.kz/report?user=jsmith&page=2&login=kim.lee', [{ value: 'portal.corp.kz', category: 'HOST' }, { value: 'jsmith', category: 'LOGIN' }, { value: 'kim.lee', category: 'LOGIN' }]],
  ['login in a query without a host', 'GET /report?agent=ivanov.a&operator=kim.lee', [{ value: 'ivanov.a', category: 'LOGIN' }, { value: 'kim.lee', category: 'LOGIN' }]],
  ['individual identification number', 'iin 900101300007 ok', [{ value: '900101300007', category: 'IIN' }]],
  ['card number with spaces', 'card 4111 1111 1111 1111 ok', [{ value: '4111 1111 1111 1111', category: 'CARD' }]],
  ['card number compact', 'card 4111111111111111 ok', [{ value: '4111111111111111', category: 'CARD' }]],
]

for (const [name, text, want] of detected) {
  test(`detects ${name}`, () => assert.deepEqual(found(text), want))
}

const ignored = [
  ['typescript type annotation', 'password: string'],
  ['names with a number of another length', 'sha_256 iso_8601 year_2024 http_404 build_123456 run_1234567'],
  ['names with five digits that continue', 'operator_12345x operator_12345_backup operator_123456'],
  ['names with five digits inside a longer name', 'my_operator_12345 lastOperator_12345 x.operator_12345a'],
  ['constant with five digits', 'ERROR_12345 Code_12345'],
  ['short prefix with five digits', 'id_12345 no_54321'],
  ['label of a field', "login: 'Войти', username: 'Username', user: 'User', login: 'Sign-in'"],
  ['account that names nobody', "user: 'admin', login: 'root', username: 'guest', user: 'anonymous', login: 'test'"],
  ['type or rule instead of a value', "username: 'string', login: 'required', user: 'object', uid: 'number'"],
  ['key that only contains a login word', "userAgent: 'mozilla', loginUrl: 'start', userRole: 'viewer', superuser: 'yes', agent: 'keepalive', operator: 'contains'"],
  ['login value that is too short or has spaces', "user: 'ab', username: 'John Smith'"],
  ['folder of a source tree', "import list from './users/list' and src/components/users/UserCard.vue and /var/app/accounts/index.ts"],
  ['page of a collection in a web address', 'https://portal.corp.kz/api/users/me https://portal.corp.kz/users/search?q=x https://portal.corp.kz/accounts/settings'.replaceAll('portal.corp.kz', 'github.com')],
  ['placeholder in a web address', 'https://github.com/api/users/{id} https://github.com/users/:id https://github.com/users/${id}/x'],
  ['file in a web address', 'https://github.com/users/avatar.png https://github.com/accounts/index.html'],
  ['query value that names nobody', 'https://github.com/report?user=admin&login=true&uid=12'],
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

const mine = { account: 'jsmith', fullName: 'John Smith', machine: 'Johns-MacBook-Pro' }
const here = (text, identities = mine) => found(text, [], ['example.org'], identities)

test('account of this machine is found in the path of a home folder', () => {
  assert.deepEqual(here('open /Users/jsmith/project/app.js and /home/jsmith/.ssh/config'), [
    { value: 'jsmith', category: 'LOGIN' },
    { value: 'jsmith', category: 'LOGIN' },
  ])
})

test('account of this machine is found as a word of its own', () => {
  assert.deepEqual(here('-rw-r--r--  1 jsmith  staff  120 notes.txt'), [{ value: 'jsmith', category: 'LOGIN' }])
})

test('account of this machine is not found inside another word', () => {
  assert.deepEqual(here('jsmithson and ajsmith and jsmith_backup'), [])
})

test('account with a name that many machines share is hidden in home folders only', () => {
  const found = here('open /Users/admin/project as admin in the admin panel', { account: 'admin' })
  assert.deepEqual(found, [{ value: 'admin', category: 'LOGIN' }])
})

test('full name of the owner is found in any letter case', () => {
  assert.deepEqual(here('Git user: John Smith, signed by JOHN SMITH'), [
    { value: 'John Smith', category: 'NAME' },
    { value: 'JOHN SMITH', category: 'NAME' },
  ])
})

test('name of this machine is found', () => {
  assert.deepEqual(here('jsmith@Johns-MacBook-Pro project %'), [
    { value: 'jsmith', category: 'LOGIN' },
    { value: 'Johns-MacBook-Pro', category: 'HOST' },
  ])
})

test('identities that are missing or too short are skipped', () => {
  assert.deepEqual(here('/Users/ab/x by Al on pc', { account: 'ab', fullName: 'Al', machine: 'pc' }), [])
  assert.deepEqual(here('/Users/jsmith/x', {}), [])
})

test('identity with regex characters is matched literally', () => {
  assert.deepEqual(here('/Users/j.smith/x and /Users/jxsmith/x', { account: 'j.smith' }), [{ value: 'j.smith', category: 'LOGIN' }])
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
