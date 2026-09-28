# llm-mask

Local proxy that masks secrets, hosts and personal data in everything Claude Code sends to the API and restores them in the replies.

## How it works

```
            YOUR MACHINE                     |          OUTSIDE
                                             |
  you --> Claude Code --> llm-mask ----------|----> API or gateway --> model
                          hides values       |      sees placeholders only
                                             |
  you <-- Claude Code <-- llm-mask <---------|----- answer with placeholders
                          restores values    |
```

Real values never cross the line. One request, step by step:

| Step | Where | What the text looks like |
|---|---|---|
| 1. You ask | your machine | `psql postgres://db.corp.example:5432/app fails, DB_PASSWORD=hunter2hunter42` |
| 2. llm-mask hides | your machine | `psql postgres://MSK_HOST_215adc229b:5432/app fails, DB_PASSWORD=MSK_SECRET_3812f97b01` |
| 3. The model answers | outside | `Check that MSK_HOST_215adc229b accepts connections on port 5432` |
| 4. llm-mask restores | your machine | `Check that db.corp.example accepts connections on port 5432` |

You read the answer from step 4. The model has only ever seen steps 2 and 3.

The same happens to files that Claude Code reads and to the output of commands it runs: they are masked on the way out. When the model asks to run a command, the placeholders in it are restored before the command runs on your machine.

## What it covers

| Covered | How |
|---|---|
| Your prompt, files read by tools, command output, memory, subagents | Everything goes through one proxy, so nothing depends on the model following instructions. |
| Secrets | Tokens of common services, private keys, JWT, `Authorization` values, passwords in assignments, credentials inside addresses. |
| Hosts and origins | Any host after a scheme, domain names standing alone. Port and path stay readable. |
| Personal data | Email, IP, phone numbers, payment card numbers, Kazakhstan IIN. |
| Logins | The value of `user`, `username`, `login` or `uid`. The part after `/users/`, `/agents/` or `/accounts/` in an address and the value of `?user=` or `?login=`. A name with five digits such as `operator_12345`. |
| This machine | The account name, also inside home folder paths, the name of the owner from git and the name of the machine. |
| What was seen once | A login or a secret found in one place is hidden everywhere else from then on. |
| Your own list | Words, domains and patterns from a dictionary, values from `.env*` files of the working directory. |
| Images | Text is recognized locally, sensitive parts are painted black before the image leaves. |

## What it does not cover

- **The code itself.** Logic, function names, file names and paths in addresses are sent as they are.
- **Anything in an image that is not recognized text:** faces, logos, diagrams, small or unusual print.
- **A host written as a single word without a scheme**, such as `pbx01` in plain text. Add those to the dictionary.
- **A login that nothing points at.** A bare word such as `jsmith` in plain text looks like any other word. It is hidden once it has been seen next to a key or inside an address, or once it is in the dictionary.
- **A plain `claude`.** Only a command started through `llm-mask run` is protected.
- **What a command does with a real value.** Local tools receive real values, otherwise they could not work. A shell command that sends data elsewhere is held back by the permission prompts of Claude Code, not by this tool.

It reduces what leaves your machine. It is not a guarantee.

## Requirements

- Node 20 or newer, no other dependencies.
- Claude Code.
- For image masking: macOS with the Swift compiler (`xcode-select --install`).

## Install

```
git clone https://github.com/abilkhan023/llm-mask.git
cd llm-mask
npm link
```

## Use

```
llm-mask run -- claude
```

An alias makes it a habit:

```
alias claude-safe='llm-mask run -- claude'
```

**With a gateway.** If `ANTHROPIC_BASE_URL` is already set, the proxy puts itself in front of it and forwards there. Credentials and protocol headers pass through unchanged. Keep your variables and change only the last word:

```
ANTHROPIC_BASE_URL=... ANTHROPIC_API_KEY=... llm-mask run -- claude
```

## Commands

| Command | Purpose |
|---|---|
| `llm-mask run -- <command>` | Start a command behind the proxy. |
| `llm-mask check <file>` | Print what would be sent instead of the file. Reads standard input without a file. |
| `llm-mask check <image>` | Write a painted copy next to the image as `name.masked.png`. |
| `llm-mask add` | Add dictionary entries from standard input. |
| `llm-mask status` | Counts per category, never values. |
| `llm-mask watch` | Open the live view of what is sent and what comes back. |
| `llm-mask help` | List the commands. Also `--help`, `-h`, or no arguments at all. |

Examples:

```
llm-mask check notes.txt                      # a file
pbpaste | llm-mask check                      # whatever is in the clipboard
llm-mask check screenshot.png                 # writes screenshot.masked.png
printf 'domain:corp.example\n' | llm-mask add # one entry
llm-mask add                                  # several entries, one per line, finish with Ctrl+D
```

Add entries from a separate terminal. Anything typed into a conversation is sent before it reaches the dictionary.

## See what is sent

While a session runs, open a second terminal:

```
llm-mask watch
```

A page opens in the browser with every request of the session and the answer to it, as a conversation. The text is shown exactly as it crossed the line, masks are drawn as bars, images are shown as they were sent.

| Part of the page | What it shows |
|---|---|
| List on the left | Every request: time, number of messages, how many values were hidden, size, answer status. |
| Instructions, tools, earlier conversation | Folded by default. They are sent again with every request. |
| Above the dashed line | What left your machine in this request. |
| Below the dashed line | What came back. |

What to know about it:

- **Nothing is written to disk.** The last 30 requests are kept in memory and are gone when the session ends.
- **Real values are never shown**, only what the model saw.
- **The page is served from your machine only**, under an address with a random key, and loads nothing from outside.
- `llm-mask watch --print` prints the address without opening the browser.

## Dictionary

`~/.llm-mask/dictionary.txt`, one entry per line:

```
# a word or a name, any letter case, three characters or more
acme
# a domain with all its subdomains
domain:corp.example
# a pattern
regex:operator_\d{5}
```

## Settings

`~/.llm-mask/config.json`. Every key is optional.

| Key | Default | Meaning |
|---|---|---|
| `media` | `"pass"` | `"pass"` sends images as they are, `"redact"` paints sensitive text, `"block"` removes every attachment. |
| `publicDomains` | about thirty well-known domains | Domains that stay readable, with their subdomains. `[]` hides every domain. |
| `keepMasked` | `["WebFetch", "WebSearch", "mcp__*"]` | Tools that receive placeholders instead of real values. |
| `envFiles` | `true` | Treat values from `.env*` files of the working directory as sensitive. |
| `systemNote` | `true` | Tell the model to copy placeholders exactly. |
| `viewer` | `true` | Keep the last requests in memory for `llm-mask watch`. |
| `identities` | `true` | Hide the account name, the owner name and the machine name of this computer. |

With `"media": "redact"`, PDF files, images given by address and images that cannot be read are removed from the request, because they cannot be inspected.

`WebFetch` receives placeholders, so fetching a page works only for domains listed in `publicDomains`.

## Where data is kept

`~/.llm-mask`, or the directory named in `LLM_MASK_HOME`. Files are readable by the owner only.

| File | Content |
|---|---|
| `key` | Key that placeholders are derived from. |
| `vault.json` | Placeholders and the real values behind them, **in plain text**. |
| `dictionary.txt` | Your entries. |
| `config.json` | Settings. |
| `audit.log` | One line per request: path, status, counts per category. No values. |
| `sessions/` | Address of the live view of each running session. Removed when the session ends. |

## Check it yourself

```
printf 'mail a.user@corp.example from 10.20.30.40' | llm-mask check
tail ~/.llm-mask/audit.log
```

## Details worth knowing

- **Same value, same placeholder.** Prompt caching keeps working.
- **Fail closed.** A request that cannot be parsed or masked is refused and not forwarded.
- **Thinking blocks are left untouched**, they are signed by the API.
- **Telemetry, error reports and the bug command of Claude Code are switched off** for the started command.
- **Certificates.** On macOS the proxy trusts the authorities your keychain trusts. Elsewhere use `NODE_EXTRA_CA_CERTS`.
- **Look-alike characters in images.** A slashed zero is often read as `ø`. Known values are found in images even then.

## Development

```
npm test
```

The first run compiles the Swift helper. See `CLAUDE.md` for the layout and the rules that must keep holding.

## License

MIT
