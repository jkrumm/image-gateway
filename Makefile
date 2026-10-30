.DEFAULT_GOAL := help

.PHONY: help up configure app app-run app-status app-logs dev check

# The sources that determine what the built app IS. Anything listed here that
# changes makes the installed app stale — see scripts/codesum.ts.
APP_SOURCES := app/src app/src-tauri/src app/src-tauri/capabilities shared/src \
               app/index.html app/vite.config.ts \
               app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml

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
	@awk 'BEGIN {FS = ":.*##"; printf "\nimage-gateway (ImageGen studio) — run \033[36mmake <target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
	@echo ""

##@ The studio

up: ## THE entrypoint: build+install the Mac app and prove it matches your working tree (`make app`). Terminates.
	@$(MAKE) --no-print-directory app

configure: ## Seed ~/Pictures/ImageGen/.imagegen/settings.json (agent-workflows image door URL + studio token, read from the mini over ssh) so the app never asks. Merges; override with AGW_DOOR_URL / AGW_DOOR_TOKEN.
	@./scripts/configure.sh

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

dev: ## `tauri dev` with HMR. For writing code; `make app` is how you actually use ImageGen.
	bun run dev

check: ## format:check + lint + typecheck across the workspaces, then the full test suite
	bun run pre
	bun test
