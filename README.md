# EvoWorld: an interactive artificial-life ecosystem

EvoWorld is a full-stack 2D simulation built as a university showcase project. Visitors watch plants, herbivores and carnivores interact, change rainfall, and inspect how simple rules affect survival and inherited traits.

## The project story

The project started with organisms searching for food, spending energy and reproducing. It grew into a food chain: rainfall produces plants, herbivores eat plants and flee predators, and hungry carnivores hunt herbivores. The goal is an understandable interactive demonstration, not a claim to reproduce a real ecosystem scientifically.

Development proceeded through requirements, explicit simulation rules, deterministic tests and independent reviews. Practical challenges included keeping the interface responsive with a worker, recovering from startup failures, smoothing infrequent position updates without changing biology, validating saved experiments, and separating public simulation from private archive management.

The hosted extension keeps the browser simulation public and puts saved experiments behind a single owner login. It preserves the local version and its data. This remains a work in progress: testing evidence and live-deployment status must be reported separately.

## How the ecosystem works

```text
Rainfall -> plants -> herbivores -> carnivores
                        |             |
                 energy and reproduction
                        |             |
                  inherited traits
```

- Plants are stationary food patches. Dry, Normal and Wet rainfall produce 2, 8 and 16 new patches per simulated second, within the cap.
- Herbivores seek sensed plants or flee sensed carnivores. Carnivores hunt herbivores when hungry.
- Maintenance consumes energy. Feeding restores energy. Animals can die from starvation, age or predation.
- Eligible animals reproduce asexually. Diet is inherited; speed and sensing mutate within fixed bounds. Each animal has at most six offspring.
- Animals follow programmed rules, not machine learning. There is no guaranteed coexistence or automatic replenishment after extinction.

Defaults: seed 42, 40 herbivores, 6 carnivores, 120 plants in a wrapping 1000 x 600 world. Simulation uses fixed 0.05-second steps. The combined animal cap is 300; reaching it pauses the run. All-animal extinction or 30 simulated minutes ends it. Reproduction requires sufficient energy, minimum age, cooldown and space under the cap.

The worker publishes confirmed snapshots. Presentation interpolates positions with a 200 ms visual delay without altering measured biology, random state or exports. Paused/ended/reset/recovery and reduced-motion views use confirmed positions.

## Technology stack

| Technology | Role |
| --- | --- |
| HTML and CSS | Accessible controls, forms, responsive layout and visual style. |
| Browser JavaScript ES modules | Controls, inspection, charts, API requests and presentation. |
| Canvas 2D | Draws the ecosystem and graphs. |
| Web Worker | Runs the deterministic simulation away from the UI thread. |
| Node.js 22.9+ within major 22 | Backend runtime; bounded in package.json for deployment compatibility. |
| Express | Same-origin static server and experiment/auth API. |
| PostgreSQL and pg | Versioned experiment records in a JSONB table. |
| Built-in Node crypto | Owner password derivation, opaque sessions and token generation. |
| Node test runner | Engine, transport, UI, API, configuration, auth and storage checks. |

No React, game engine or machine-learning service is required. Runtime npm dependencies are Express and pg with their supporting packages.

## Visitor and owner workflows

Visitors can choose initial settings, start/pause/resume/end, use 1x/2x/4x speed, change rainfall, inspect animals and download their results as JSON. Keyboard inspection: focus the world, Enter to select, arrows to cycle, Escape to clear.

In hosted owner mode, the archive is private. The owner signs in to save ended experiments, browse/compare compatible records and delete individual saved records after named confirmation. Direct API requests enforce the same restriction. Visitors need no account. Login state is not stored in localStorage.

Sessions expire after four hours and are lost on server restart or free-host sleep. Log in again when needed. Production cookies are HttpOnly, Secure and SameSite=Strict; mutations require origin and CSRF checks. Login attempts are bounded. The server deliberately does not trust arbitrary forwarded IP headers, so a hosted proxy may share a conservative login-rate bucket across users.

JSON export remains available when storage is unavailable. Saved records are analytical results, not resumable worlds. Download important in-memory results before refreshing. Deletion does not reset the current simulation or remove an available current-result JSON download.

## Local startup

Requirements: Node.js in the range declared by package.json, npm, and PostgreSQL for the optional local archive.

From a terminal in the cloned project folder:

```powershell
npm.cmd ci
```

If .env does not already exist, copy the safe example and edit it privately:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set DATABASE_URL to your local PostgreSQL database. Password characters inside the URL must be encoded, for example @ becomes %40. Never commit or share actual credentials.

Initial database setup, once:

```powershell
npm.cmd run db:setup
```

Normal startup:

```powershell
$env:PORT = '3001'
npm.cmd start
```

Open http://localhost:3001. Keep the terminal open; Ctrl+C stops the server. Local mode is permitted only on loopback. Existing installations do not repeat dependency/database setup each time. EADDRINUSE means the port is occupied; check the existing process before starting another.

Dependency-free preview:

```powershell
node server/preview.js
```

Preview normally uses port 3000 and provides simulation/JSON only. It does not load .env or support archive operations. It is separate from the full Express server.

## Free hosted deployment

Chosen architecture: public GitHub source -> Render Free Node web service -> Neon Free PostgreSQL. The repository includes render.yaml as a template: the web service plan is explicitly free, auto-deploys are off, and secret values are prompted rather than stored in YAML. It creates no Render database or paid resource.

Create accounts without payment details. If any required step requests payment, stop rather than upgrade. Free quotas, sleep and provider policy changes can affect availability; always-on or perpetual free hosting is not promised. Render may take about a minute to wake. Its filesystem is disposable, so experiment data belongs in PostgreSQL, not local files.

Configure through the hosting dashboard, never this repository:

| Variable | Value or source |
| --- | --- |
| NODE_ENV | production |
| HOST | 0.0.0.0 |
| AUTH_MODE | owner |
| PUBLIC_ORIGIN | Exact HTTPS origin assigned to the service, without a path. |
| OWNER_PASSWORD | New private owner password, 16 to 1024 characters, separate from other passwords. |
| DATABASE_URL | Fresh Neon database connection string with required TLS parameters intact. |
| PORT | Provided by Render; do not hardcode the local port. |

Build command: npm ci. Start command: npm start. Keep automatic deployments off and select a tested version manually. package.json constrains Node to major 22; remove any incompatible account-level NODE_VERSION override.

Production/Render/non-loopback configurations cannot use unprotected local mode and refuse missing owner configuration. Private local .env files are not uploaded or replaced with hosted credentials. The new hosted archive starts empty. Database schema initialisation uses the existing table/index setup; no local data migration is implied.

Current status: hosting code is implemented locally. The latest integrated check recorded 232 tests: 231 passed, 0 failed, 1 dedicated-database fixture skipped. No public URL or completed cloud deployment is claimed until verified. Public release follows the prepared-file/privacy review and account configuration.

## API

| Route | Access and purpose |
| --- | --- |
| GET /api/health | Public service/database availability. |
| GET /api/auth/session | Public auth state; CSRF token only for a valid owner session. |
| POST /api/auth/login | Same-origin owner-password sign-in. |
| POST /api/auth/logout | Authenticated origin/CSRF-protected logout. |
| GET /api/experiments | Owner-only paginated summaries in hosted mode. |
| GET /api/experiments/:id | Owner-only full saved record. |
| POST /api/experiments | Owner-only validated save with stable retry/conflict handling. |
| DELETE /api/experiments/:id | Owner-only exact-ID deletion: 204 removed, 404 absent. |

Archive pages contain 20 summaries. Compare within the same model type; differing versions are flagged. Legacy Baseline records remain distinguishable from Food chain records without fabricated data. Authentication failures reach no archive storage operation.

## Source map

- public/simulation.js: biological rules.
- public/simulation-worker.js and worker-runtime.js: worker transport/scheduling.
- public/simulation-client.js: commands, run identity and recovery.
- public/app.js, ui-helpers.js, index.html, styles.css: UI and presentation.
- server/app.js and index.js: API/static serving and startup.
- server/auth.js and config.js: owner access and fail-closed runtime settings.
- server/store.js, validation.js, archive.js and record/baseline helpers: persistence and validation.
- tests/: deterministic, transport, UI, HTTP, security/config and storage checks.

Internal conversation logs, private planning material, source backup archives and database exports are intentionally outside the public release. .env.example contains placeholders only; .env and other secret variants are ignored.

## Tests and known limits

```powershell
npm.cmd test
npm.cmd run test:core
```

HTTP/storage/UI doubles do not establish actual cloud or native-browser acceptance. Real persistence fixtures require an explicitly supplied TEST_DATABASE_URL pointing to a dedicated disposable test database; DATABASE_URL alone never opts in. Never use valued application records as test fixtures.

Before public release, verify anonymous and owner workflows, direct API denials, origin/CSRF checks, expiry/logout/restart, database persistence, desktop/phone operation and free-service wake-up. Keep the local working version and private JSON copies of important results as fallbacks. Additional species, seasons, multiplayer, visitor accounts and saved-world resumption remain deferred.
