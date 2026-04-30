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

Firebase credentials (required for duplicate-checking and storing results):

```
FIREBASE_USER_ID=...
FIREBASE_AUTH_EMAIL=...
FIREBASE_AUTH_PASSWORD=...
REACT_APP_FIREBASE_API_KEY=...
REACT_APP_FIREBASE_AUTH_DOMAIN=...
REACT_APP_FIREBASE_PROJECT_ID=...
REACT_APP_FIREBASE_STORAGE_BUCKET=...
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=...
REACT_APP_FIREBASE_APP_ID=...
```

## Adding queries

Queries live in `queries/queries.csv`. Each row is a matched English/Indonesian pair:

```csv
pair_id,en,id
pair-001,Prabowo foreign policy 2025,prabowo kebijakan luar negeri 2025
pair-002,rising rice prices government response Indonesia,harga beras naik solusi pemerintah
```

**Columns:**

| Column | Required | Description |
|--------|----------|-------------|
| `pair_id` | Recommended | Stable identifier (e.g. `pair-042`). Auto-generated from row number if omitted. |
| `en` | Yes | English query |
| `id` | Yes | Indonesian (Bahasa) query |

**Rules:**
- Lines starting with `#` are treated as comments and ignored.
- Queries must not contain commas — no CSV escaping is performed.
- Both `en` and `id` are run as separate searches; leave one blank to skip it.
- `pair_id` values must be unique across the file and must not contain `/`.

To add a new topic, append a row with the next available `pair_id`:

```csv
pair-043,new topic in English,topik baru dalam bahasa Indonesia
```

Pair metadata is synced to Firestore at `users/{FIREBASE_USER_ID}/query_pairs` at the start of each run, while the events themselves are stored at `users/{FIREBASE_USER_ID}/en` for english and `users/{FIREBASE_USER_ID}/id` for indonesian respectively.

## Running

```bash
npm start                              # uses queries/queries.csv
npm start queries/queries_test.csv     # pass a custom query file
npm start queries/queries.csv --fresh  # ignore the saved checkpoint and start over
```

When the runner starts, a Chrome window opens with the extension loaded. The extension's options page appears automatically — sign in there, and the runner continues once authentication completes.

> **Note:** Change extension settings (e.g. AI Overview Mode) _before_ signing in, because queries start immediately after authentication.

If Google serves a CAPTCHA, solve it in the browser window and the runner resumes automatically.

### Resume / checkpoint

The runner saves a checkpoint after each query pair. If a run is interrupted, restarting with the same query file automatically picks up where it left off. Pass `--fresh` to discard the checkpoint and start from the beginning.

## Storage

Results are written to `query_results/<stem>.results.json` (e.g. `query_results/queries.results.json`) and also synced to the Firebase project configured in `.env`. The local file contains a summary and per-query results.

Before running each query, the runner signs in with Firebase Auth and checks Firestore at `users/{FIREBASE_USER_ID}/{en|id}` for a document whose `query` field matches the normalized query text (trimmed and lowercased). Queries already present are skipped to avoid duplicate writes. If authentication or the Firestore lookup fails, the run exits immediately.

### Search mode

The runner reads `search_mode_preference` from the extension's storage:

| Value | Behaviour |
|-------|-----------|
| `all` (default) | Plain Google search |
| `ai` | Forces AI Overview (`udm=50`) |
| `no_ai` | Suppresses AI Overview (`udm=14`) |
| `random` | Randomly alternates between `ai` and `no_ai` |
