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

Add your search queries to a text file (one per line, `#` for comments). The filename determines the language tag stored with each event (e.g. `queries_en.txt` → `"en"`).

## Running

```bash
npm start                        # uses queries_in.txt by default
npm start queries_en.txt         # pass a custom query file
```

On first run, Chrome opens with the extension loaded. If you are not yet signed in, the extension's options page opens automatically — sign in there and the runner continues.

If Google serves a CAPTCHA, solve it in the browser window and the runner resumes automatically.

### Search mode

The runner reads the `search_mode_preference` from the extension's storage:

| Value | Behaviour |
|-------|-----------|
| `all` (default) | Plain Google search |
| `ai` | Forces AI Overview (`udm=50`) |
| `no_ai` | Suppresses AI Overview (`udm=14`) |
| `random` | Randomly alternates between `ai` and `no_ai` |
