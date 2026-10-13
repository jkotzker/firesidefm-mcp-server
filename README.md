# firesidefm-mcp-server

An [MCP](https://modelcontextprotocol.io) server for the [Fireside.fm](https://fireside.fm) podcast hosting API. It lets an MCP host such as Claude Code or Claude Desktop read your podcasts, episodes and download statistics, create, edit, publish and unpublish episodes, and upload episode audio, cover art and transcripts.

This is an unofficial project. It is not affiliated with or endorsed by Fireside.

## Requirements

- Node.js 22 or later
- A Fireside API key, created at <https://app.fireside.fm/api_tokens>

A **Read Only** key enables the read tools; a **Read/Write** key also enables the tools that change episodes. Use a Read Only key unless you want your assistant to create, edit or publish episodes. A key covers every podcast on your Fireside account. A key can be switched between Read Only and Read/Write under Account > API Keys; restart the server afterwards, since it chooses its tools when it starts.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `FIRESIDE_API_TOKEN` | yes | Your Fireside API key (`fire_…`). |
| `FIRESIDE_PODCAST` | no | Token or slug of the podcast to use when a request doesn't name one. |
| `FIRESIDE_READ_ONLY` | no | `true` to offer only the read tools, even with a Read/Write key. |
| `FIRESIDE_UPLOAD_DIRS` | no | Directories whose files may be uploaded, separated as in `PATH` (`:` on macOS and Linux, `;` on Windows). Absolute paths; `~` stands for your home directory. Uploads are off when this is not set. |

At startup the server checks the key with Fireside. The write tools are offered only when the key is Read/Write and `FIRESIDE_READ_ONLY` is not set. A rejected key stops the server with an explanation on stderr. If the key cannot be checked for any other reason, such as a network error or a Fireside outage, the server starts with only the read tools and says why on stderr; restart it to try again.

`fireside_upload_file` is offered only with a Read/Write key and `FIRESIDE_UPLOAD_DIRS` set. It sends only files inside those directories (symbolic links are followed before the check; a hard link cannot be told apart from the file it points to), so set it to the folders where you keep finished episode files rather than your home directory.

Both hosts below store the key in plain text in their configuration file.

## Claude Code

```sh
claude mcp add fireside \
  --env FIRESIDE_API_TOKEN=fire_… \
  --env FIRESIDE_PODCAST=your-podcast-slug \
  -- npx -y firesidefm-mcp-server
```

This adds the server for the current project only. Add `--scope user` to make it available in every project.

## Claude Desktop

Edit Claude Desktop's configuration file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add an entry under `mcpServers` (create the object if the file doesn't have one yet):

```json
{
  "mcpServers": {
    "fireside": {
      "command": "npx",
      "args": ["-y", "firesidefm-mcp-server"],
      "env": {
        "FIRESIDE_API_TOKEN": "fire_…",
        "FIRESIDE_PODCAST": "your-podcast-slug"
      }
    }
  }
}
```

Then quit and reopen Claude Desktop.

Claude Desktop does not read your shell profile, so if Node was installed with a version manager such as nvm, it may not find `npx`. In that case set `"command"` to the full path printed by `which npx`.

## Tools

Podcasts and episodes can be named by token or by slug. An episode's slug defaults to its episode number, so "episode 42" works unless the slug was customised in the dashboard (for example `s02e04`).

| Tool | Needs Read/Write key | What it does |
|---|---|---|
| `fireside_get_account` | | The connected account and whether its key is Read Only or Read/Write. |
| `fireside_list_podcasts` | | Podcasts you own or collaborate on. |
| `fireside_get_podcast` | | One podcast's details and all-time downloads. |
| `fireside_list_episodes` | | Episodes, newest first, including drafts and scheduled ones; filter by status. |
| `fireside_get_episode` | | Every field of one episode, including show notes. |
| `fireside_get_episode_metrics` | | Downloads per episode at 1, 7, 14, 30 and 90 days, Spotify, and total. |
| `fireside_get_monthly_downloads` | | Downloads per calendar month and the all-time total. |
| `fireside_create_episode` | ✓ | Create a private draft episode, optionally with audio, cover art and a transcript. |
| `fireside_update_episode` | ✓ | Change title, subtitle, slug, show notes, season, type, explicit flag, audio, cover art or transcript. |
| `fireside_upload_file` | ✓ | Upload an MP3, cover image (JPG, PNG, GIF or WebP) or plain-text transcript from `FIRESIDE_UPLOAD_DIRS`, and attach it to an episode or return a `file_url` for create and update. |
| `fireside_publish_episode` | ✓ | Publish now, schedule, or backdate; public or unlisted. |
| `fireside_unpublish_episode` | ✓ | Return an episode to a private draft. |

`fireside_get_episode` includes the episode's preview link, which plays the episode for anyone who has it, even before release.

Before uploading an MP3, the server reads its headers. A file that holds no MP3 audio (such as a renamed WAV) is refused. One that differs from the settings the Fireside dashboard suggests for MP3s (mono, 64–96 kb/s, 44.1 kHz) is stopped with a list of the differences; your assistant should ask you, and uploads it as it is only with `accept_audio_specs: true`. The audio limit depends on your Fireside plan, which the API does not report; Fireside checks the size before anything is sent, and the server then names the file's size as a likely cause.

Uploaded audio transfers to the episode in the background; `audio_status` on the episode shows `processing`, then `ready` or `failed` (with `audio_error`). Cover art and transcripts are attached during the call. Large audio files can take longer to upload than an MCP host allows for a tool call; in Claude Code, raise the limit with the `MCP_TOOL_TIMEOUT` environment variable (milliseconds).

## Limitations

These come from the Fireside API itself:

- Chapters cannot be uploaded through the API. Publishing an episode without audio fails.
- Files must fit your plan's limits: cover art up to 1.91 MB, transcripts up to 195 KB, and audio within your plan's MP3 limit.
- Episodes cannot be deleted, and podcast settings cannot be changed.
- Publishing also posts to the podcast's connected social accounts when the episode is set to do so in the dashboard. The API cannot see or change that setting.
- Requests are limited to 120 per minute per key. The server waits out short rate-limit pauses and reports longer ones.

## Development

```sh
npm install
npm run build       # compiles to dist/
npm run typecheck
npm test            # unit and in-process MCP tests; no network
npm run test:e2e    # builds, then runs dist/cli.js over stdio against a local stand-in API
npm run check       # all of the above
npm run dev         # run from source with tsx
```

`scripts/` holds two checks that run against the real Fireside API with a key read from the macOS Keychain; see the comment at the top of each file. `live-read-check.ts` only reads. `live-draft-check.ts` creates and edits one draft episode, which you then delete in the dashboard; it refuses to send publish or unpublish requests.

## License

[MIT](LICENSE)
