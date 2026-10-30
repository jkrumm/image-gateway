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
