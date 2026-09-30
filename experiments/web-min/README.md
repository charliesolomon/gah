# web-min: a browser front end for a running GAH, at its smallest (#119)

Exploratory. Nothing here is wired into `bin/gah`, the host launcher, or the
Windows package, and nothing should be until #119 decides to build something.

## The short answer

**One HTML file is not enough on its own, and cannot be.** A browser cannot
read a process's stdin/stdout or connect to a Unix socket, and GAH's
interactive surface (`gah --mode rpc`) is exactly that: JSON lines on a child
process's stdio. So the minimum is two small pieces:

| Piece | Here | Size | Dependencies |
|---|---|---|---|
| The page | `index.html` | ~215 lines, one file | none: vanilla JS, no build |
| The bridge | `bridge.mjs` | ~215 lines, a third of it comments | none: Node, already a GAH prerequisite on Linux and Windows |

The bridge starts **one policed `gah --mode rpc` child as the person running
it** and relays: `GET /events` (Server-Sent Events, every record gah writes,
replayed for a page that reconnects) and `POST /cmd` (one command to gah's
stdin). Everything that makes it GAH still happens in the child: tool
allowlist, audit log, protected paths, provider restrictions, skills, the
What's new notes. The page only draws the session and sends commands.

## What was verified

| Check | Result |
|---|---|
| Local, `bin/gah --mode rpc` + a mock model that makes a native tool call, driven in headless Chrome | Startup `notify` (What's new) shown; header shows the model; `/` lists gah's commands; a prompt → `ls` tool call rendered collapsed with its output → markdown answer; gah's audit log records `allowed:ls` |
| Reload the page mid-session | The bridge replays; transcript rebuilt with no duplicates; an answered dialog does not reopen |
| `/model` | Picker lists exactly the models policy exposes |
| No token / foreign `Host` / cross-origin POST | 401 / 421 / 403 |
| **Linux server, real model**: bridge on the shared host as the person's own account, on a 0600 Unix socket; laptop `ssh -N -L 8765:<socket> host`; headless Chrome on the laptop | A Bedrock session (Sonnet 5.5) through the page: `ls` tool call and answer; the person's `-N` SSH login reaches the socket without starting their login shell |
| RPC `bash` (the TUI's `!`) under policy | No shell allowed → refused and audited `blocked / shell_escape`; shell allowed → runs, audited `user_bash`. Safe to expose as `!` |
| **Windows 11 client** | **Not run.** See the Windows risks below; the code path exists, nothing is proven. |

Found and fixed on the way: with nothing yet to replay, Node held the SSE
response headers, so the page's `EventSource` never opened while the page
waited for it to open before sending anything. The bridge now writes a comment
at once, and a heartbeat every 25 s so an idle SSH forward or proxy keeps the
stream.

## Options, for a Win11 client and for a Linux server

GAH runs in two shapes today: on a person's **Windows 11** machine
(`bin\gah.ps1`, or the deployment package's `gah.ps1`, both needing only Node),
and on a **shared Linux host** the person reaches over SSH (`gah-launch` as
their login shell, inside tmux). Every option has to keep one property: the
session runs **as that person**, or the audit log and per-person credentials
stop meaning anything.

### Option A — the terminal, in a browser (not an HTML client at all)

Serve the existing TUI through a web terminal (xterm.js over a pty; `ttyd` is
the one-binary version). The experience is not "replicated", it is the same
program.

| | Win11 client | Linux server |
|---|---|---|
| How | A pty server on localhost running `gah.ps1`. Needs ConPTY: `ttyd` has a Windows build, or `node-pty` (a native module: a compiler or a prebuilt binary on a managed machine) | `ttyd` (distro package) per person, running `gah-launch`, on a 0600 Unix socket, reached with `ssh -L` like option B |
| Gains | Zero protocol work; every TUI feature, keybinding and extension works as is | Same; xterm.js renders OSC 8 hyperlinks, which tmux 3.2a on the host cannot pass through today |
| Costs | A native or third-party binary on managed machines; still a terminal, just in a tab | A new package on the host; still a terminal |

Pick this if the goal is *access from a browser*. It does not answer "an
HTML client".

### Option B — RPC bridge + one page (this prototype)

| | Win11 client | Linux server |
|---|---|---|
| How | `node bridge.mjs` beside the install; the default command is `powershell.exe -NoProfile -ExecutionPolicy Bypass -File bin\gah.ps1 --mode rpc`; binds `127.0.0.1` with a per-run token; the browser is on the same machine | Per-person bridge on `~/.gah/<name>.sock` (0600), started as that person; the laptop runs `ssh -N -L 8765:<socket> host` (OpenSSH ships with Windows 11) and opens `http://127.0.0.1:8765/?t=…` |
| Identity | Trivially the person: their machine, their process | The person's own Unix account, because their own SSH login reaches their own 0600 socket; no shared service account |
| Exposure | Loopback only, token, Host and Origin checks. Other local users are the residual risk, which the token covers | A loopback **port** would be reachable by every account on the host, so the bridge takes a 0600 **socket**; the token still applies |
| Verified | No | Yes, against the real host and model |
| Gaps | See "Windows risks" | Needs a launcher entry point; see "What the launchers would need" |

This is the literal answer to #119.

### Option C — attach to the session already running

pi 0.99 ships `@earendil-works/pi-server` (experimental: a Unix-socket server,
several clients attached to one session) and `@earendil-works/pi-client`
(transport-neutral, CBOR). That is the shape for "open the session I left in
tmux, from a browser". It targets upstream's new durable session interfaces,
not the coding-agent extension path the policy pack runs on, and nothing here
shows that GAH's policy applies there. **Watch; do not build on it yet.**

### Not an option — a shared web service with its own login

A single server process that logs people in and runs sessions for them runs
them all as one account, or needs privilege to switch accounts. Either breaks
the per-person identity that audit and credentials rest on, and it is far from
minimal. Out of scope (#119).

## Windows risks (to check on a Win11 machine before anything else)

1. **stdin through Windows PowerShell 5.1.** The bridge writes commands to
   `powershell.exe`, which runs `gah.ps1`, which starts `node` with `&`. That
   the native child inherits a *redirected* stdin, and that nothing buffers
   it, is expected but unproven. Test:
   `'{"type":"get_state"}' | powershell -NoProfile -File .\bin\gah.ps1 --mode rpc`
   should print one `response` line.
2. **UTF-8 on stdout.** Windows PowerShell can re-encode native output through
   the console code page when stdout is redirected. A `—` or non-Latin text in
   a reply is the test. If it mangles, the fallback is for `gah.ps1` to report
   the exact `node` command and environment it would run, and the bridge to
   start that directly, so the launcher still owns the policy wiring.
3. `gah.ps1` writes to the host only in its `init` and `update-skills`
   subcommands, not on a normal launch; the bridge also sends any
   non-protocol stdout line to stderr rather than to the page.

## What the launchers would need (both platforms)

- **An RPC entry point.** `gah-launch` accepts no arguments, so the prototype
  bypassed it and ran `bin/gah` directly. That lost what the launcher adds: the
  skills sync and `--skill` paths, the manifest's `GAH_WHATS_NEW`, the KB path.
  Something like `gah-launch --rpc` (and the same in `gah.ps1`) doing the same
  pre-flight, with every pre-flight message on **stderr**.
- **Setup steps cannot run under a bridge.** They are interactive, and in RPC
  mode stdout is the protocol. The bridge sets `GAH_SKIP_SETUP=1`. A first run
  still has to happen in a terminal, or the steps move to extension UI dialogs
  (`input`, `confirm`), which RPC already carries.

## The checklist from #119

| Item | Prototype | Notes |
|---|---|---|
| Streaming text | yes | Tiny markdown: fences, inline code, bold, links, headings |
| Thinking | shown | Does not honour `hideThinkingBlock` yet; easy later |
| Tool calls and results | yes | Collapsed `<details>` with args and output |
| Prompt / steer / abort | yes | Enter sends; while working, Enter steers; Esc aborts |
| Follow-up | no | `streamingBehavior: "followUp"`; easy later |
| Slash commands, templates, skills | yes | `get_commands` hints; extension commands, `/skill:…` and templates run through `prompt` |
| TUI built-ins (`/model`, `/new`) | mapped | `/resume`, `/settings`, `/login`, `/tree` are TUI code: each needs its own RPC mapping or is dropped |
| `!` bash | no | RPC `bash` is policy-gated and audited (verified); easy later |
| Model / thinking pickers | model yes | Thinking level: `set_thinking_level`, easy later |
| Extension UI | yes | `notify`, `select`/`confirm`/`input`/`editor` as dialogs, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` |
| Startup header | own | The TUI's banner is TUI-only; the page draws a one-line header from `get_state` |
| Footer | partial | Context use from `get_session_stats`; model in the header |
| Sessions: list, resume | no | `switch_session`, `get_entries`; needs a list UI |
| Reconnect | partial | Page reconnects and rebuilds from the replay; if the bridge or gah exits, the session ends (the TUI has tmux for that) |
| Images, file paste | no | `prompt` accepts base64 images |

## Run it

Linux, from a built checkout, against whatever models your environment allows:

```bash
node experiments/web-min/bridge.mjs            # prints http://127.0.0.1:8765/?t=…
```

On a shared host, as yourself:

```bash
node experiments/web-min/bridge.mjs --socket ~/.gah/web.sock
# on your machine:
ssh -N -L 8765:/home/<you>/.gah/web.sock <host>   # then open the printed URL
```

Windows (untested, see above):

```powershell
node experiments\web-min\bridge.mjs
```

`-- <command…>` replaces the gah command, for example
`-- bin/gah --mode rpc --model provider/model`.
