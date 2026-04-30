# AI Overview Query Runner

Playwright automation that batch-runs Google searches with the [AI Overview Tracker](../AI-Overview-Tracker) Chrome extension loaded, recording which queries trigger an AI Overview.

## Prerequisites

- Node.js
- The AI Overview Tracker extension checked out locally
- A Chromium installation (Playwright installs one automatically)

## Setup

```bash
npm install
npx playwright install chromium
```

Copy the environment file and point it at your extension:

```bash
cp .env.example .env
# Edit .env — set EXTENSION_PATH to the local path of AI-Overview-Tracker
```

Optional timing overrides (defaults in milliseconds):

| Variable | Default | Description |
|----------|---------|-------------|
| `SETTLE_TIME` | `5000` | Wait after page load before checking for AI Overview |
| `QUERY_DELAY` | `5000` | Pause between queries |
| `AUTH_POLL_INTERVAL` | `2000` | How often to check for sign-in / CAPTCHA resolution |
| `EXTENSION_READY_TIMEOUT` | `10000` | Max wait for extension to initialise after sign-in |

Add your search queries to a text file (one per line, `#` for comments). The filename determines the language tag stored with each event (e.g. `queries_en.txt` → `"en"`).

## Running

```bash
npm start                        # uses queries_in.txt by default
npm start queries_en.txt         # pass a custom query file
npm start queries_en.txt --fresh # ignore any saved checkpoint and start over
```

Each run creates a fresh Chrome profile, so the extension's sign-in state does not persist between runs. The extension's options page opens automatically — sign in there and the runner continues once authenticated. If you want to change extension settings (e.g. AI Overview Mode), do so before signing in, because queries start immediately after authentication completes.

If Google serves a CAPTCHA, solve it in the browser window and the runner resumes automatically.

### Resume / checkpoint

The runner saves a checkpoint after each query. If a run is interrupted, restarting with the same query file automatically picks up where it left off. Pass `--fresh` to discard the checkpoint and start from the beginning.

## Storage

Results are written to `query_results/<stem>.results.json` (e.g. `query_results/queries_en.results.json`) and also synced to the Firebase configured in the extension. The local file includes a summary and per-query results.

> **Note:** if the query filename does not match `queries_<lang>.txt`, the language tag defaults to `"unknown"` and Firestore events are stored under an `"unknown"` collection. Rename the file to fix this.

### Search mode

The runner reads the `search_mode_preference` from the extension's storage:

| Value | Behaviour |
|-------|-----------|
| `all` (default) | Plain Google search |
| `ai` | Forces AI Overview (`udm=50`) |
| `no_ai` | Suppresses AI Overview (`udm=14`) |
| `random` | Randomly alternates between `ai` and `no_ai` |
