# llm-mask

Local proxy that masks secrets, hosts and personal data in everything Claude Code sends to the API and restores them in the replies.

```
            YOUR MACHINE                     |          OUTSIDE
                                             |
  you --> Claude Code --> llm-mask ----------|----> API or gateway --> model
                          hides values       |      sees placeholders only
                                             |
  you <-- Claude Code <-- llm-mask <---------|----- answer with placeholders
                          restores values    |
```

1. Claude Code is started with `ANTHROPIC_BASE_URL` pointed at llm-mask on `127.0.0.1`.
2. llm-mask replaces sensitive values in the request with placeholders and forwards it.
3. The reply comes back with placeholders, llm-mask puts the real values in.
4. Tools on the machine run with real values.

A placeholder looks like `MSK_HOST_3fa9c1d2ab`: the category and a keyed hash of the value.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Whole suite on the Node built-in runner. The first run compiles the Swift helper. |
| `node --test test/detectors.test.js` | One test file. |
| `node bin/llm-mask.js run -- claude` | Start a command behind the proxy. |
| `node bin/llm-mask.js check <file or image>` | Show what would be sent instead of the file. |
| `node bin/llm-mask.js add` | Add dictionary entries from standard input. |
| `node bin/llm-mask.js status` | Counts per category, never values. |
| `node bin/llm-mask.js help` | List the commands. The list lives in `USAGE` in `bin/llm-mask.js`, keep it in step with `commands`. |

Requirements: Node 20 or newer. Image masking needs macOS with the Swift compiler.

## Layout

| Path | Responsibility |
|---|---|
| `bin/llm-mask.js` | Command line entry. |
| `src/launcher.js` | Opens a session, starts the proxy on a free local port, runs the command with `ANTHROPIC_BASE_URL` pointed at it. |
| `src/config.js` | `config.json`, `dictionary.txt` and values from `.env*` files of the working directory. |
| `src/detectors.js` | Built-in patterns, dictionary entries and host rules. Returns matches without overlaps. |
| `src/vault.js` | Value to placeholder and back, persisted in the data directory. |
| `src/masker.js` | `locate`, `mask`, `unmask`. |
| `src/request.js` | Which fields of a Messages request and response are touched. |
| `src/stream.js` | Restores placeholders in a streamed reply, including ones split between chunks. |
| `src/proxy.js` | The HTTP proxy itself. |
| `src/media.js` | Finds what to paint in images, removes what cannot be inspected. |
| `src/native.js`, `native/ocr.swift` | Text recognition and painting through Vision. |
| `src/trust.js` | Certificate authorities from the macOS keychain and `NODE_EXTRA_CA_CERTS`. |

Data lives outside the repository in `~/.llm-mask` (or `LLM_MASK_HOME`): `key`, `vault.json`, `dictionary.txt`, `config.json`, `audit.log`.

## Rules that must keep holding

- **Fail closed.** A body that cannot be parsed or masked is refused and never forwarded. An image that cannot be inspected is removed from the request.
- **Masking is deterministic.** The same value always gives the same placeholder, otherwise prompt caching breaks.
- **Thinking blocks pass through untouched** in both directions. They are signed, any change makes the API reject the conversation.
- **Text is matched exactly.** Look-alike matching (`0` read as `ø`) is for recognized image text only, because nothing is restored into an image.
- **Tools that send data outside keep placeholders.** `keepMasked` lists them: `WebFetch`, `WebSearch`, `mcp__*` by default.
- **Tool names, ids, the model name and schema keys are never masked.**
- **The audit log holds categories and counts, never values.**
- **Certificate verification is never switched off.**
- **No runtime dependencies.**

## Working agreements

- Write the test first and watch it fail for the right reason. When a test passes on the first run, break the code on purpose and confirm the test notices.
- No comments in code.
- Tests use made-up values only: `corp.example`, `masktest.example`, fictional phone numbers. Never a real hostname, name, number or token.
- A new host or pattern rule is checked against real source code for false matches before it is kept. Property access such as `messages.ru` or `booted.ua` must stay readable.
- Never print or log a real secret. When a script needs a value from a shell profile or a keychain, read it inside the script and keep it out of the output.
- Do not commit or push unless asked.
