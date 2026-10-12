.DEFAULT_GOAL := help

.PHONY: help up configure app app-run app-status app-logs dev check \
        deploy verify logs gateway-deploy gateway-status gateway-smoke gateway-logs gateway-logs-bounded

# The sources that determine what the built app IS. Anything listed here that
# changes makes the installed app stale — see scripts/codesum.ts.
APP_SOURCES := app/src app/src-tauri/src app/src-tauri/capabilities shared/src \
               app/index.html app/vite.config.ts \
               app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml

# Read a secret without ever hanging. `secrets-run` (the age-encrypted offline cache) is the
# headless path and fails fast when a ref is not seeded; plain `op` is the fallback for a signed-in
# human. The timeout is load-bearing, not defensive padding: on the mini `op` blocks forever on a
# biometric prompt nobody is there to approve, which turns any target that reads a secret into a
# hang rather than an error. Callers get an empty string and decide what to say.
#   usage: VALUE=$$($(call op_read,op://vault/item/field))
op_read = secrets-run read $(1) 2>/dev/null || timeout 15 op read $(1) --account tkrumm </dev/null 2>/dev/null

BUNDLE    := app/src-tauri/target/release/bundle/macos/ImageGen.app
# /Applications is not writable on an MDM-managed Mac, and `sudo cp` for a
# personal app is the wrong trade — macOS treats ~/Applications as a first-class
# app folder (Spotlight, Launchpad, `open -a` all find it). Pick the shared one
# when we may write it, ours otherwise; override with INSTALL_DIR=.
INSTALL_DIR ?= $(shell [ -w /Applications ] && echo /Applications || echo $(HOME)/Applications)
INSTALLED := $(INSTALL_DIR)/ImageGen.app
STAMP     := $(INSTALLED)/Contents/Resources/.codesum
BUNDLE_ID := com.jkrumm.image-gen
APP_LOG   := $(HOME)/Library/Logs/$(BUNDLE_ID)/imagegen.log

help: ## Show this help (default target — a bare `make` runs it)
	@awk 'BEGIN {FS = ":.*##"; printf "\nimage-gateway — run \033[36mmake <target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
	@echo ""

##@ Contract — the machine-facing interface (AGENTS.md ## Validate / ## Deploy / ## Verify & Monitor)

deploy: ## Ship the merged default branch: re-trigger the RollHook gateway deploy and wait for it. (The Mac app is installed locally by `make app`, not deployed here.)
	@$(MAKE) --no-print-directory gateway-deploy

verify: ## Probe production: is the gateway live and healthy, and running the image built from your HEAD? Exits non-zero when not.
	@$(MAKE) --no-print-directory gateway-status

logs: ## Bounded tail of the deployed gateway's logs (last 200 lines, then exits)
	@$(MAKE) --no-print-directory gateway-logs-bounded

##@ Both halves

up: ## THE entrypoint: bring both halves to your working tree — build+install the Mac app, deploy the gateway — and prove each one. Terminates.
	@echo "==> [1/2] Mac app"
	@$(MAKE) --no-print-directory app
	@echo ""
	@echo "==> [2/2] Gateway"
	@$(MAKE) --no-print-directory gateway-deploy
	@echo ""
	@$(MAKE) --no-print-directory app-status
	@$(MAKE) --no-print-directory gateway-status
	@echo "✓ both halves match your working tree"

configure: ## Seed ~/Pictures/ImageGen/.imagegen/settings.json from 1Password (gateway URL + token) so the app never asks for them. Re-run after rotating the token.
	@BASE=$$($(call op_read,op://vps/image-gateway/BASE_URL)); \
	TOKEN=$$($(call op_read,op://vps/image-gateway/API_SECRET)); \
	if [ -z "$$BASE" ] || [ -z "$$TOKEN" ]; then \
	  echo "✗ could not read the gateway URL/token from 1Password."; \
	  echo "  This machine is headless-by-default: plain 'op' blocks on a biometric prompt, so the"; \
	  echo "  refs below need to be in dotfiles-private/headless.refs, then 'make secrets-seed':"; \
	  echo "      op://vps/image-gateway/BASE_URL"; \
	  echo "      op://vps/image-gateway/API_SECRET"; \
	  echo "  (Or run 'op signin --account tkrumm' in this shell first, with someone present.)"; \
	  exit 1; \
	fi; \
	mkdir -p "$(HOME)/Pictures/ImageGen/.imagegen"; \
	umask 077; \
	printf '{\n  "gateway": { "baseUrl": "%s", "token": "%s" }\n}\n' "$$BASE" "$$TOKEN" > "$(HOME)/Pictures/ImageGen/.imagegen/settings.json"; \
	chmod 600 "$(HOME)/Pictures/ImageGen/.imagegen/settings.json"; \
	echo "✓ wrote ~/Pictures/ImageGen/.imagegen/settings.json (chmod 600) — restart the app to pick it up"

##@ The Mac app — this is how you actually use ImageGen

app: ## Build the release bundle, install it to /Applications, prove it matches your working tree, then exit. CLEAN=1 discards the cargo cache first (see below).
	@# On "rebuild without cache so it's surely clean": the fingerprint check at the end of this
	@# target is a STRONGER guarantee than --no-cache, not a weaker one. A cacheless rebuild only
	@# tells you the build was fresh; it cannot tell you the artifact in /Applications came from
	@# the tree in front of you, which is the thing you actually want to know — and it cannot
	@# distinguish "the cache was stale" from "the cache was fine and something else is wrong",
	@# so pulling it lets you skip a diagnosis rather than complete one. Both cargo and Vite key
	@# their caches on content hashes, so a changed file always rebuilds its unit.
	@#
	@# CLEAN=1 exists anyway, because "I want to rule the toolchain out" is a legitimate call to
	@# make about a compiler you do not control. It costs a full cargo rebuild (~10 min vs ~70s),
	@# so it is opt-in and the assertion below runs either way.
	@if [ "$(CLEAN)" = "1" ]; then \
	  echo "  CLEAN=1 — discarding the cargo cache (full rebuild, several minutes)"; \
	  cd app/src-tauri && cargo clean; \
	fi
	cd app && bun run tauri build --bundles app
	@# Guard the overwrite. /Applications is shared with every other app on the
	@# machine and this target does `rm -rf` — so refuse unless what is already
	@# there is unmistakably a previous install of OURS. A stranger's app with
	@# the same name is a situation for a human, not for a Makefile.
	@if [ -e "$(INSTALLED)" ]; then \
	  ID=$$(plutil -extract CFBundleIdentifier raw "$(INSTALLED)/Contents/Info.plist" 2>/dev/null || echo "?"); \
	  if [ "$$ID" != "$(BUNDLE_ID)" ]; then \
	    echo "✗ $(INSTALLED) exists but its bundle id is '$$ID', not '$(BUNDLE_ID)' — refusing to overwrite something that isn't ours."; \
	    exit 1; \
	  fi; \
	fi
	@# Copying over a running app leaves it running the deleted bundle: the old
	@# code stays live in memory, so you would "verify" the new build by clicking
	@# around in the old one. Quit it first. Checked with `pgrep -x` on the exact
	@# executable name — never a broad `pkill -f` pattern, which SIGTERMs whatever
	@# else happens to match (see dotfiles rules/makefile-conventions.md).
	@if pgrep -x image-gen >/dev/null 2>&1; then \
	  echo "  quitting the running ImageGen before replacing it…"; \
	  osascript -e 'tell application id "$(BUNDLE_ID)" to quit' >/dev/null 2>&1 || true; \
	  for i in 1 2 3 4 5 6 7 8 9 10; do \
	    pgrep -x image-gen >/dev/null 2>&1 || break; \
	    sleep 1; \
	  done; \
	  if pgrep -x image-gen >/dev/null 2>&1; then \
	    echo "✗ ImageGen is still running after 10s — quit it by hand, then re-run. (Not force-killing: it owns writes to ~/Pictures/ImageGen.)"; \
	    exit 1; \
	  fi; \
	fi
	mkdir -p "$(INSTALL_DIR)"
	rm -rf "$(INSTALLED)"
	cp -R "$(BUNDLE)" "$(INSTALLED)"
	@bun scripts/codesum.ts $(APP_SOURCES) > "$(STAMP)"
	@# ASSERT, don't nuke — this is the check that makes CLEAN=1 optional rather than
	@# necessary (see the note at the top of this target). The fingerprint recorded
	@# inside the installed bundle must equal a fresh fingerprint of the working tree.
	@# A mismatch means the tree was edited mid-build, so the .app just installed is
	@# already not what is on disk.
	@$(MAKE) --no-print-directory app-status
	@echo "✓ installed → $(INSTALLED)   (launch it: make app-run)"

app-run: ## Launch the installed app — refuses if it is not built from your current working tree.
	@if [ ! -e "$(INSTALLED)" ]; then echo "✗ not installed. Run: make app"; exit 1; fi
	@$(MAKE) --no-print-directory app-status
	@open -a "$(INSTALLED)"
	@echo "✓ launched. Logs: make app-logs"

app-status: ## Is the app in /Applications actually built from your working tree? Exits non-zero if not.
	@if [ ! -e "$(INSTALLED)" ]; then echo "✗ $(INSTALLED) does not exist — run: make app"; exit 1; fi
	@printf "  verifying the installed app matches your working tree… "
	@HOST=$$(bun scripts/codesum.ts $(APP_SOURCES)); \
	INST=$$(cat "$(STAMP)" 2>/dev/null); \
	if [ -z "$$INST" ]; then \
	  echo "NO FINGERPRINT"; \
	  echo "✗ the installed app carries no fingerprint — it predates this Makefile, or was copied in by hand. Re-run: make app"; \
	  exit 1; \
	elif [ "$$HOST" = "$$INST" ]; then \
	  echo "ok ($$HOST)"; \
	else \
	  echo "MISMATCH"; \
	  echo "✗ the app in /Applications is NOT your working tree — what you see in it is code you no longer have."; \
	  echo "    working tree: $$HOST"; \
	  echo "    installed:    $$INST"; \
	  echo "  Rebuild with: make app"; \
	  exit 1; \
	fi

app-logs: ## Tail the running app's log (this one does not terminate — Ctrl-C to stop)
	@test -f "$(APP_LOG)" || { echo "no log yet at $(APP_LOG) — start the app first (make app-run)"; exit 1; }
	tail -f "$(APP_LOG)"

##@ Development — for changing the code, not for using the app

dev: ## Dev-server pair: gateway on :7716 (--watch) + `tauri dev` with HMR. For writing code; `make app` is how you actually use ImageGen.
	bun run dev

check: ## format:check + lint + typecheck across all workspaces, then the full test suite
	bun run pre
	bun test

##@ Gateway

gateway-deploy: ## Deploy gateway/ + shared/ to the VPS via RollHook and wait for the rollout to land.
	@# RollHook builds from GitHub master, so anything uncommitted or unpushed simply is not in
	@# the deploy. Say that up front rather than reporting success for someone else's code.
	@if [ -n "$$(git status --porcelain -- gateway shared)" ]; then \
	  echo "✗ gateway/ or shared/ has uncommitted changes — RollHook builds from GitHub master, so they would not be deployed."; \
	  git status --short -- gateway shared | sed 's/^/    /'; \
	  exit 1; \
	fi
	@if [ -n "$$(git log origin/master..master --oneline -- gateway shared)" ]; then \
	  echo "✗ gateway/ or shared/ commits are not pushed — RollHook would build the previous state:"; \
	  git log origin/master..master --oneline -- gateway shared | sed 's/^/    /'; \
	  exit 1; \
	fi
	gh workflow run deploy.yml --repo jkrumm/image-gateway --ref master
	@printf "  waiting for the rollout… "
	@sleep 5
	@for i in $$(seq 1 60); do \
	  STATUS=$$(gh run list --repo jkrumm/image-gateway --limit 1 --json status,conclusion --jq '.[0].status + ":" + (.[0].conclusion // "")'); \
	  case "$$STATUS" in \
	    completed:success) echo "ok"; break;; \
	    completed:*) echo "FAILED"; echo "✗ deploy failed — 'gh run view --repo jkrumm/image-gateway --log-failed'"; exit 1;; \
	  esac; \
	  sleep 5; \
	done

gateway-status: ## Is the deployed gateway healthy, and is it running the image built from your HEAD?
	@# Same idea as the app's fingerprint: the running image is tagged with the git SHA it was
	@# built from, so comparing it to HEAD proves the deployed code is the code you have. A
	@# healthy container says nothing about WHICH code is healthy. (These comments live outside
	@# the shell block below on purpose — that block is one backslash-continued command, so a
	@# `#` inside it would comment out everything that follows.)
	@printf "  verifying the deployed gateway matches your HEAD… "
	@RUNNING=$$(ssh vps 'docker inspect --format "{{.Config.Image}}" $$(docker ps -q --filter "label=com.docker.compose.service=image-gateway") 2>/dev/null' 2>/dev/null | sed 's/.*://'); \
	HEAD_SHA=$$(git rev-parse HEAD); \
	if [ -z "$$RUNNING" ]; then \
	  echo "UNKNOWN"; \
	  echo "✗ could not read the running image tag over ssh — the deployed version is unverified."; \
	  exit 1; \
	elif [ "$$RUNNING" != "$$HEAD_SHA" ]; then \
	  echo "MISMATCH"; \
	  echo "✗ the gateway is serving an image built from a different commit than your HEAD."; \
	  echo "    HEAD:     $$HEAD_SHA"; \
	  echo "    deployed: $$RUNNING"; \
	  echo "  Deploy with: make gateway-deploy"; \
	  exit 1; \
	fi; \
	echo "ok ($$(echo $$RUNNING | cut -c1-12))"
	@# The health probe is a bonus, not the verification — and it is the only part that needs a
	@# hostname. Degrade rather than fail when the URL is unavailable: BASE_URL is a non-secret
	@# coordinate that merely lives in 1P (the repo is public and must not hardcode the host), so
	@# an unseeded cache is no reason to withhold the SHA check that just passed.
	@BASE=$${IMAGE_GATEWAY_BASE_URL:-$$($(call op_read,op://vps/image-gateway/BASE_URL))}; \
	if [ -z "$$BASE" ]; then \
	  echo "  ⚠ skipped the /health probe — no gateway URL available (set IMAGE_GATEWAY_BASE_URL or seed op://vps/image-gateway/BASE_URL)"; \
	  exit 0; \
	fi; \
	printf "  probing %s/health… " "$$BASE"; \
	HEALTH=$$(curl -sS --max-time 15 "$$BASE/health" 2>/dev/null); \
	if [ "$$HEALTH" = '{"status":"ok"}' ]; then echo "ok"; else echo "UNHEALTHY"; echo "✗ returned: $$HEALTH"; exit 1; fi

gateway-logs: ## Tail the deployed gateway's container logs (does not terminate — Ctrl-C to stop)
	ssh vps 'docker logs -f $$(docker ps -q --filter "label=com.docker.compose.service=image-gateway")'

gateway-logs-bounded: ## Print the last 200 lines of the deployed gateway's logs, then exit (the `make logs` contract target)
	ssh vps 'docker logs --tail 200 $$(docker ps -q --filter "label=com.docker.compose.service=image-gateway")'

gateway-smoke: ## Probe the deployed gateway: /health (unauthenticated) + an authenticated /enhance round trip.
	@BASE=$${IMAGE_GATEWAY_BASE_URL:-$$($(call op_read,op://vps/image-gateway/BASE_URL))}; \
	if [ -z "$$BASE" ]; then echo "✗ set IMAGE_GATEWAY_BASE_URL=https://<host> or seed op://vps/image-gateway/BASE_URL"; exit 1; fi; \
	echo "  GET $$BASE/health"; \
	curl -sS --max-time 10 "$$BASE/health" || { echo "✗ unreachable — the gateway is Tailscale-only, so check the tailnet first"; exit 1; }; \
	echo ""; \
	TOKEN=$$($(call op_read,op://vps/image-gateway/API_SECRET)); \
	if [ -z "$$TOKEN" ]; then echo "⚠ no API_SECRET available — skipping the authenticated probe"; exit 0; fi; \
	echo "  POST $$BASE/enhance"; \
	curl -sS --max-time 60 -X POST "$$BASE/enhance" \
	  -H "Authorization: Bearer $$TOKEN" -H "Content-Type: application/json" \
	  -d '{"brief":"a small red fox icon, flat vector style"}' | head -c 400; \
	echo ""
