# PRD: image-gateway — Personal Image Generation Gateway and Studio

## Problem

I design apps, generate art (journal covers, article images), and create icons and web assets, but had no personal tool for it. The MVP (phases 1–3, built 2026-07) solved transport: a stateless gateway wrapping the gpt-image family and a Tauri app with compose/edit/refine/library tabs and a disk-backed library. What it did not solve is the *creative workflow*: prompting expertise lives in my head, generation settings are hand-picked every time, the library is a flat sort-only grid that hides derived work, editing is blind to the library, styles and brand context aren't entities, and the enhance endpoint has no UI at all.

The redesign turns the app from an API console into a studio with a brain. Full mental model, IA, user stories, and design rationale: **`docs/concept.md`**. Prompting doctrine: **`docs/prompting-playbook.md`** (splitting into `shared/playbook/` — the enhancer's compiled system prompt and the in-app reference). This PRD holds scope, waves, and success criteria.

## Goals

1. **Prompt intelligence.** A brief becomes a **Plan**: playbook-conditioned prompt + auto-derived settings (model/size/quality/background/n/endpoint) + policy pre-check + cost estimate — always shown before run, always editable, never silent. Iteration is delta-based with preserve lists; series consistency comes from prompt context (project anchors), not chained edits.
2. **Library as a DAM.** Projects (many-to-many, context-capturing, item-authoritative membership), behavioral roles + star, prompt/param search with facets, visible lineage (ancestors + children incl. refine derivatives), use-as trio on every image, imports of external assets. Refine becomes an inspector action; the tab dies.
3. **Style guides as first-class entities.** Named bundles (verbatim palette, typography feel, vocabulary, ≤40-word fragment, avoid-list, reference images) distilled by the gateway from library images, `design.md`, website screenshots, or CSS — attachable to any Plan as fragment + edit references.
4. **Policy-aware generation.** The pre-check warns before spend, rewrites toward compliant phrasing visibly, names hard walls instead of contorting, and turns upstream `moderation_blocked` errors (stage + categories) into guided recovery. Never an evasion tool.
5. **Cost-shaped workflow.** Draft at low (n>1, streamed previews on by default), promote winners to high deliberately. The 35.8× spread is a first-class UX concern.

## Non-goals

- MCP facade, multi-user, cloud state, public exposure. Delivery/sharing of finished assets is out of scope for this repo (it lives in a separate app); the gateway returns bytes, the app writes them to the local library.
- Style strength sliders, lineage graph canvases, embeddings/semantic search, auto-tagging, chat-shaped enhancement, in-app playbook editing, moderation simulators (rejected with rationale in `docs/concept.md` §9).
- SQLite in the first waves — in-memory index over sidecars; SQLite is the named escape hatch.
- SVG vectorization is not scheduled. Transparency (previously an open gap needing local matting) shipped natively 2026-09-23 — both generatable models have a real alpha channel; status lives in `AGENTS.md` → *The studio generates on two models*.

## Waves (each ships working software; wave 1 may ship in slices, but the concept must stand across all of them)

### Wave 0 — Verify the floor (human, on the MacBook — done 2026-07-21)
Drive the MVP surface: plain generate, streamed generate, multi-ref edit, masked inpaint, library→edit seed, `/enhance` curl. Fix what breaks. Commit the MVP. **Nothing in waves 1+ builds on unverified runtime behavior.** Also probe: `moderation=low` on `/images/edits` per model; `moderation_details` presence in our proxy's wrapped errors.

### Wave 1 — The brain and the merge
- `shared/playbook/` (split from `docs/prompting-playbook.md`) + `PLAYBOOK_VERSION`; contract v2 schemas (plan request/response, sidecar schema 2 types).
- Gateway: `POST /enhance` v2 (modes auto/full/gaps/off, intent detection, verbatim post-check, settings derivation validated by `rules.ts`, policy warnings, cost estimate, series/style/preserve context) with system prompt compiled from the playbook; `moderation_details` passthrough; `GET /` reports `playbook_version`.
- App: **Create surface** (Compose+Edit merged; library reference picker; Plan card with marked additions, editable prompt, derived-settings prefill, warnings with one-click rewrites, cost-before-run; persisted draft state); streaming previews on by default (dormant SSE client goes live); moderation-block recovery UX (stage-aware advice, no auto-retry).
- Library: sidecar **schema 2** (read-time migration), roles + star + search + facets, lineage panel, use-as trio, Tweak/Re-run/Promote differentiated, Refine relocated to the inspector, Refine tab removed.

### Wave 2 — Organization and style
- Projects: sidebar, context capture, retroactive/bulk filing, anchors + series context in Plans, per-project cost roll-up.
- Style guides: `.imagegen/styles/`, `POST /styles/distill` (sources: library images + `design.md`), Styles surface, attach chip, proof sheet; imports (`kind: import`) so external brand assets can seed guides and references.

### Wave 3 — Sharpening (trajectory items promoted as reality demands)
Screenshot + CSS distillation sources; chained-edit drift guard; saved searches; enhance eval corpus surfaced as few-shot context; named work-items/bench (concept §10) if multi-round work strains persisted drafts.

## Key constraints (live-probed; details `docs/research/endpoint-verification.md` + `AGENTS.md`)

- Capability matrix (`MODEL_CAPABILITIES`) is the single source of truth, keyed by `KnownImageModel`: `gpt-image-2.5-flare`/`-sunburst` = custom sizes, transparency, extended quality (`xhigh`/`max`), rejects `input_fidelity`; legacy `gpt-image-2`/`-1.5`/`-1-mini` retired from generate, kept for historical sidecars. **2026-09-23**: `IMAGE_MODELS` is now the flare/sunburst pair (`resolveModel` routes `auto` between them by endpoint/quality — see `AGENTS.md`); `validateBackgroundForModel()` passes for both, so transparency is producible again. The Plan's derivations must round-trip through `rules.ts`, never re-derive.
- Cost (per generatable model, at 1024×1024): low ≈ $0.006, medium ≈ $0.013, high ≈ $0.053 (~9×), xhigh ≈ $0.094, max ≈ $0.211 (~35.8×); streaming overhead is per-model (flare: none; sunburst: ~+$0.002); upstream may send fewer partials than requested — never wait on a fixed count.
- Upstream wraps user errors in 503 — either `"..._user_error"` in the body, or (gpt-image-2.5-era) a `StatusCode: BadRequest`-prefixed body with `"type":"invalid_request_error"` and no `user_error` substring; `moderation_blocked` is one of the former — never retried, either shape.
- Gateway stays stateless; all state in `~/Pictures/ImageGen/` (sidecars authoritative, human-browsable, index rebuildable). Public repo: placeholders only, secrets via 1Password templates.

## Success criteria

1. A three-word brief produces a Plan whose prompt follows the playbook's canonical order, whose settings I don't have to touch for the common cases, and whose every addition and assumption is visible and editable before a cent is spent.
2. Pasting a 140-word expert prompt leaves it untouched (passthrough banner) — the enhancer never overwrites deliberate precision.
3. An icon set, a 2560×1440 on-brand hero (from a distilled style guide), and journal cover #4 that visibly belongs to covers #1–3 are each producible end-to-end in the UI without re-typing style context.
4. Any image's ancestry and descendants (edits, promotes, refine exports) are one click from its detail view; "where is that image from three weeks ago" is a search, not Finder archaeology.
5. A policy-sensitive artistic brief gets a visible compliant rewrite or an honest hard-wall refusal before spend; a `moderation_blocked` response yields stage-aware guidance, never a blind retry.
6. Every generation still lands in a Finder-browsable folder whose sidecar alone reconstructs prompt, plan, project membership, roles, and lineage — delete `.imagegen/` index state and nothing is lost.
7. Hermes (or curl) can call `/enhance` + `/generate` and inherit the same brain and policy guard — the gateway remains client-agnostic and stateless.

## Architecture (unchanged foundation)

Bun monorepo: `gateway/` (Elysia, stateless, Docker/Makefile deploy, Tailscale-only, bearer auth), `app/` (Tauri v2, React + Mantine v9 + basalt-ui), `shared/` (zod contract + `rules.ts` + playbook). Implementation details are the implementing agent's call within these boundaries; `docs/concept.md` §6–8 specifies the data model, gateway shapes, and playbook structure.
