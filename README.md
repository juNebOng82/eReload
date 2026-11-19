# eReload

Multi-tenant USSD top-up gateway. Companies call a REST API, the server queues and routes each request, and real Android phones (one eReload app per telco SIM) dial the USSD code after a Firebase Cloud Messaging push.

| Folder | What it is |
|---|---|
| `server/` | Node.js server (`index.js`), admin panel and company portal (`public/`), Dockerfile for Cloud Run |
| `android/` | Android app `com.ereload.app` (Kotlin), v1.16 |
| `docs/` | Project knowledge base: architecture, data model, business rules, API, guides, decisions, roadmap |

Start with [`docs/00_README_PROJECT_INSTRUCTIONS.md`](docs/00_README_PROJECT_INSTRUCTIONS.md).

Secrets are not in this repo. Copy `server/.env.example` to `.env` for local runs, and add your own `android/app/google-services.json` before building the app.
