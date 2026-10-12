# Deploying image-gateway to the VPS

Ingress is **Tailscale-only** — a grey-cloud DNS-only A record (`image-gateway.<your-domain>` → the VPS
Tailscale IP) routed to **Traefik**, _not_ through the Cloudflare Tunnel (same pattern as `argo`,
`audio-gateway`, and `research-gateway`). Deploys are **label-driven via rollhook** (OIDC,
zero-downtime). The app repo ships only the code, `Dockerfile`, and the
`.github/workflows/deploy.yml` trigger. The compose file, the prod `.env`, and the Cloudflare DNS
record live in the **`vps`** repo + the Cloudflare dashboard.

The hostname is `image-gateway`, not `image`. The zone already serves an unrelated image CDN at
`img.<your-domain>` (plus its `img-origin.<your-domain>`), and a bare `image.<your-domain>` sitting
next to those is a name you have to think about every time you read it. The `-gateway` suffix says
which system it belongs to. (The zone is not otherwise consistent about this — `audio-gateway` has
the suffix, `research` does not — so follow the disambiguation, not a convention.)

## 1. Create the 1Password item

Create the gateway-specific secret (account `tkrumm`):

- `op://vps/image-gateway/API_SECRET` — generate a strong random bearer (the gateway's token).

`OPENAI_BASE_URL` / `OPENAI_API_KEY` reuse the existing shared item (`op://common/anthropic/*`);
`ARGO_API_SECRET` reuses `op://common/api/SECRET`.

## 2. Add the service to the vps repo

```bash
mkdir -p ~/SourceRoot/vps/apps/image-gateway
cp deploy/compose.yml  ~/SourceRoot/vps/apps/image-gateway/compose.yml
cp deploy/.env.tpl     ~/SourceRoot/vps/apps/image-gateway/.env.tpl
```

Add Makefile targets in the vps repo mirroring the `research-gateway-*` ones
(`image-gateway-up`, `-down`, `-env`, `-redeploy`, `-bootstrap-image`). The env target is:

```make
image-gateway-env:
	op --account tkrumm inject -i apps/image-gateway/.env.tpl -o apps/image-gateway/.env -f
	chmod 644 apps/image-gateway/.env
```

Run `make image-gateway-env` to materialize the gitignored `.env`. Re-run after rotating any
secret.

## 3. Cloudflare DNS (Tailscale-only)

The gateway is **tailnet-only** — every consumer (Claude Code, Hermes, other agents) is on the
tailnet, so it is _not_ exposed to the public internet. Access is gated at the DNS layer (a
grey-cloud A record to a CGNAT address is unreachable off-tailnet); the bearer token is
defense-in-depth on top.

Add the DNS record exactly like `research.<your-domain>` / `audio-gateway.<your-domain>` (via the
`/cloudflare` skill or the dashboard):

- `image-gateway.<your-domain>` → **A record, DNS-only (grey cloud, `proxied:false`)** → the VPS
  Tailscale IP (`op://vps/config/VPS_TAILSCALE_IP`).

**Do NOT** add it to the cloudflared tunnel ingress. Traefik's `:443` is already bound to the
Tailscale interface and the wildcard `*.<domain>` DNS-01 cert already covers the hostname, so no
per-host tunnel entry and no separate cert issuance are needed.

## 4. Bootstrap + first deploy

The Docker build context for `gateway/Dockerfile` is the **repo root** (monorepo — the gateway
depends on the `shared/` workspace package), so any build/deploy tooling must pass `context: .`
and `dockerfile: gateway/Dockerfile`, as `.github/workflows/deploy.yml` does.

1. Push the repo to `github.com/jkrumm/image-gateway` (default branch `master`).
2. Seed the initial registry image so rollhook has a container to authorize against (mirror
   argo's/research-gateway's `bootstrap-image.sh`), then `make image-gateway-up` once on the
   VPS.
3. Subsequent deploys: push to `master` (touching `gateway/**` or `shared/**`) → the `deploy.yml`
   workflow calls rollhook-action (OIDC) → zero-downtime rolling update. The
   `rollhook.allowed_repos=jkrumm/image-gateway` label on the running container authorizes it.

## 5. Smoke test

```bash
TOKEN=$(op read "op://vps/image-gateway/API_SECRET" --account tkrumm)
BASE=https://image-gateway.<your-domain>

curl -sS "$BASE/health"   # {"status":"ok"} — tailnet-only

curl -sS -X POST "$BASE/generate" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt":"a small red fox icon, flat vector style","size":"1024x1024"}' \
  | jq '{model, routed, size, cost}'
```

## Notes / caveats

- **Stateless by design** — no volumes, no database. Any replica can serve any request; rollhook's
  zero-downtime rolling update needs no draining coordination beyond the built-in `/health` 503
  during shutdown.
- **`GPT_IMAGE_2_SIZE` constraints and model routing are enforced gateway-side** before the
  upstream call — see `src/lib/routing.ts`. Upstream 4xx/5xx responses are surfaced as `502` with
  the `errorResponseSchema` shape; a `410` (deprecated model) fails fast with no retry.
