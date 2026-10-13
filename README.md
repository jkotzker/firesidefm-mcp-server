# firesidefm-mcp-server

An [MCP](https://modelcontextprotocol.io) server for the [Fireside.fm](https://fireside.fm) podcast hosting API. It lets an MCP host such as Claude Code or Claude Desktop read your podcasts, episodes and download statistics, and create, edit, publish and unpublish episodes.

This is an unofficial project. It is not affiliated with or endorsed by Fireside.

> **Status:** pre-release (0.1.0). Not yet published to npm; run it from a local build for now.

## Requirements

- Node.js 22 or later
- A Fireside API key, created at <https://app.fireside.fm/api_tokens>. A **Read Only** key enables the read tools; a **Read/Write** key also enables the tools that change episodes.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `FIRESIDE_API_TOKEN` | yes | Your Fireside API key (`fire_…`). |
| `FIRESIDE_PODCAST` | no | Token or slug of the podcast to use when a request doesn't name one. |
| `FIRESIDE_READ_ONLY` | no | `true` to offer only the read tools, even with a Read/Write key. |

At startup the server checks the key with Fireside. The write tools are offered only when the key is Read/Write and `FIRESIDE_READ_ONLY` is not set. A rejected key stops the server with an explanation on stderr.

## Use with Claude Code (local build)

```sh
npm install && npm run build
claude mcp add fireside \
  --env FIRESIDE_API_TOKEN=fire_… \
  --env FIRESIDE_PODCAST=your-podcast-slug \
  -- node /path/to/firesidefm-mcp-server/dist/cli.js
```

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
| `fireside_create_episode` | ✓ | Create a private draft episode. |
| `fireside_update_episode` | ✓ | Change title, subtitle, slug, show notes, season, type or explicit flag. |
| `fireside_publish_episode` | ✓ | Publish now, schedule, or backdate; public or unlisted. |
| `fireside_unpublish_episode` | ✓ | Return an episode to a private draft. |

## Limitations

These come from the Fireside API itself:

- Audio, artwork, transcripts and chapters cannot be uploaded through the API. Upload audio in the Fireside dashboard before publishing; publishing an episode without audio fails.
- Episodes cannot be deleted, and podcast settings cannot be changed.
- Publishing also posts to the podcast's connected social accounts when the episode is set to do so in the dashboard. The API cannot see or change that setting.
- Requests are limited to 120 per minute per key. The server waits out short rate-limit pauses and reports longer ones.

## Development

```sh
npm install
npm run typecheck
npm test            # unit and in-process MCP tests; no network
npm run test:e2e    # builds, then runs dist/cli.js over stdio against a local stand-in API
npm run dev         # run from source with tsx
```

## License

[MIT](LICENSE)
