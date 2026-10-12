# Local dev secrets template — consumed via `secrets-run` (drop-in op shim; see the
# package.json `dev` script). Substitutes only bare op:// refs, mirroring `op run`.
# Verify exact vault/item paths with `/secrets`.
#
#   secrets-run run --env-file=.env.local.tpl -- bun --watch src/index.ts

PORT=7716

# Gateway's own bearer (clients send this as `Authorization: Bearer <…>`).
# Literal on purpose: localhost dev needs no real secret, and keeping it out of
# 1Password lets `bun run dev` work on the headless mini (cache backend) without
# seeding a prod-tier ref. Prod uses op://vps/image-gateway/API_SECRET (deploy/.env.tpl).
API_SECRET=dev-local

# Upstream OpenAI-compatible endpoint (the unified IU endpoint). Full base URL
# including any path prefix — `/images/generations` is appended by the gateway.
OPENAI_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
OPENAI_API_KEY=op://common/anthropic/API_KEY

# Telemetry → argo POST /usage/records. ON by default, deliberately: a local dev
# generation spends real IU tokens exactly like a prod one, so leaving it off would
# silently under-report actual spend. Prod posts to argo over the internal
# monitoring-net docker route (deploy/.env.tpl); local has to use the public host.
# Comment both out only if you're deliberately generating throwaway junk.
ARGO_USAGE_URL=https://argo.jkrumm.com/api/usage/records
ARGO_API_SECRET=op://common/api/SECRET

# Tags every usage record so local spend is distinguishable from the VPS's in argo.
# Defaults to "vps" in env.ts — an unset MACHINE here would mislabel local runs.
MACHINE=local
