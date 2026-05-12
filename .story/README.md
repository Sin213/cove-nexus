# .story — Cove Nexus

Lightweight project state, tickets, handovers, and working notes for Cove Nexus.

## Layout

- `project-state.md` — current known state of the project (architecture touchpoints, recent work, upcoming work).
- `tickets/` — one file per ticket, named `T-NNN-short-slug.md`.
- `handovers/` — session handoff notes, named `YYYY-MM-DD-slug.md`.
- `notes/` — freeform working notes that don't belong in a ticket or handoff.

## Conventions

- Tickets are the unit of work. Reference them by ID (e.g. `T-001`) in commits and handovers.
- Handovers summarize what was done in a session and the recommended next step.
- Authoritative sources remain: repo files, `git diff`, tests, and the active handoff. `.story/` is supporting context, not a substitute for the code.
- Do not duplicate `CLAUDE.md`, `WORKFLOW.md`, or `RELEASES.md` content here — link or reference instead.
