# Claude sessions for OpenClaw

Ask an **existing Claude Code session** through an OpenClaw agent. OpenClaw
returns its agent's answer on the channel that started the conversation. The
plugin registers two tools; it does not implement or require a channel adapter.

It does not create sessions, replace ACP, or bind chat conversations to Claude.
The agent chooses an exact session for each request. Quoting a message on a
channel does not automatically establish a session route.

## Requirements

- OpenClaw 2026.9.8 or later; Node 24.16+ on macOS or Linux. The initial target
  is 2026.9.8; later host releases need compatibility checks.
- The `claude-socket` CLI from this repository on each target host.
- A live Claude Code session with a compatible Unix messaging socket. See the
  [CLI guide](https://github.com/mbelinky/claude-code-socket-transport/blob/main/cmd/claude-socket/README.md)
  for protocol versions, permissions, and account profiles.
- Execution as the Claude session owner, locally or through an existing SSH
  config alias. SSH must work without interactive prompts.

Install the CLI on each target host (requires Go 1.25+):

```sh
go install github.com/mbelinky/claude-code-socket-transport/cmd/claude-socket@main
claude-socket list
```

If Claude holds external messages, its owner must review the `crossSessionInbound`
setting. The plugin never changes that setting, tool permissions or credentials.

## Installation

From a checkout of this repository:

```sh
cd openclaw-plugin
npm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/mbelinky-openclaw-claude-sessions-0.1.0-beta.1.tgz --no-enable
```

The package has no runtime npm dependencies. The Go CLI is a separate
prerequisite. These instructions do not assume an npm registry release exists.

Merge this example into OpenClaw's configuration using its supported editor or
config commands. Preserve existing plugin and tool allowlists:

```json
{
  "plugins": {
    "allow": ["claude-sessions"],
    "entries": {
      "claude-sessions": {
        "enabled": true,
        "config": {
          "hosts": {
            "workstation": {
              "ssh": "my-workstation",
              "binary": "/absolute/path/to/claude-socket",
              "configDir": "/absolute/path/to/claude-profile",
              "agents": ["assistant"],
              "sessions": ["11111111-1111-4111-8111-111111111111"]
            }
          }
        }
      }
    }
  },
  "tools": {"alsoAllow": ["claude-sessions"]}
}
```

Replace the agent ID and session UUID with real values. Omit `ssh` for local
execution, and `configDir` for the owner's default Claude profile. Use
`sessions: ["*"]` only to grant access to **every** session in that profile.
The optional tools also require OpenClaw's tool policy grant.

```sh
openclaw plugins reload claude-sessions
openclaw plugins inspect claude-sessions --runtime --json
```

## Tools

- `claude_sessions_list({host?})`: list authorized live sessions with names and
  UUIDs. Discovery errors are reported per host. Socket paths are not exposed.
- `claude_sessions_ask({host, session_id, request_id, text, timeout_seconds?})`:
  send text once and wait up to 120 seconds for a correlated answer. Supply a
  fresh request UUID for each intended request. Text is limited to 12,000
  characters and passed on stdin, never through shell arguments.

Example request to an authorized OpenClaw agent:

> Find my Claude session named “website”, ask for its current status, and show
> me its answer. Do not ask it to change files.

Names are for discovery. Sending requires the exact host and session UUID.
Claude replies are untrusted content, not new authority or independent proof
that a claimed action happened.

## Access and failures

Giving an agent access extends that access to conversations the agent serves.
Restrict channel senders and tool policies in OpenClaw; use a dedicated agent
for sensitive sessions. Sandboxed agent contexts are rejected. Requests can
trigger actions under the Claude session's existing permissions.

| Status | Meaning |
| --- | --- |
| `reply` | Correlated Claude answer received. |
| `not_sent` | Rejected before sending. |
| `refused` | Claude rejected or expired the request. |
| `uncertain` | Delivery or reply is unknown; Claude can still be working. |
| `in_progress` | The same request is running in this plugin instance. |
| `already_completed` | Previously completed; not sent again. |

A request UUID is bound to the caller conversation, host, session, text and
wait timeout. Changed arguments are rejected. A crash leaves unfinished
requests uncertain. There are no automatic retries. Never bypass an uncertain
result by automatically generating another UUID. Cancellation stops the wait;
it **does not cancel accepted Claude work**.

At most eight plugin operations run concurrently. The CLI serializes asks to
the same session, including reply waits. Human input is not locked out.

The plugin stores metadata in
`<OpenClaw state>/plugin-state/claude-sessions/requests.sqlite` with directory
mode 0700 and file mode 0600. It retains IDs, fingerprints, status, timestamps
and transport IDs, not prompts or answers. OpenClaw and Claude retain their own
conversation histories. Deduplication records do not expire automatically;
do not delete them while requests can be replayed. Duplicate completion
results cannot recover answer text; use the original tool result.

## Checks and release

Run `npm test` here with Go and Python 3 installed. Tests load the registered
tools, build the real Go CLI, and reuse its disposable Unix peer. They exercise
restart, access restrictions, concurrency, refusal, timeout, cancellation and
stdin safety over the SSH boundary. TAP output is the result artifact.

Before release, check `npm pack --dry-run`, install using the native `npm-pack:`
command, inspect registration, and run a harmless ask through an authorized
agent. Fixtures do not prove a new Claude version's wire compatibility or
message delivery through every chat provider.
