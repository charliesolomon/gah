# GAH top-level workflow. Run `make` (or `make help`) for the command list.
#
# The recipes wrap scripts/* and the upstream PI build so that the day-to-day
# loop fits on a single screen and no one has to remember where each step lives.

PI_DIR := vendor/pi

.DEFAULT_GOAL := help
.PHONY: help install install-hooks build build-all refresh-models smoke patches bundle-policy clean-vendor sync sync-init status patch-new patch-export

help: ## Show available targets
	@awk 'BEGIN { FS = ":.*##"; printf "Usage: make <target> [VAR=value]\n\nTargets:\n" } \
	      /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' \
	      $(MAKEFILE_LIST)

install: ## Install npm deps in vendor/pi (run after first sync-init)
	cd $(PI_DIR) && npm install

install-hooks: ## Symlink scripts/git-hooks/* into .git/hooks/ (one-time per clone)
	@for hook in scripts/git-hooks/*; do \
	  name=$$(basename $$hook); \
	  ln -sf ../../$$hook .git/hooks/$$name && echo "✓ .git/hooks/$$name → $$hook"; \
	done

build: ## Incremental build of coding-agent (after patch edits)
	cd $(PI_DIR) && npm --workspace packages/coding-agent run build

build-all: ## Full build chain: tui → ai → agent → coding-agent (offline)
	@echo ">>> building tui"
	cd $(PI_DIR) && npm --workspace packages/tui run build
	@echo ">>> building ai (offline — see refresh-models)"
	cd $(PI_DIR)/packages/ai && npx tsgo -p tsconfig.build.json
	cd $(PI_DIR) && for p in agent coding-agent; do \
	  echo ">>> building $$p" && \
	  npm --workspace packages/$$p run build || exit 1; \
	done

# packages/ai's own `build` script runs generate-models + generate-image-models,
# which FETCH live catalogs (models.dev, openrouter, nvidia, vercel) and rewrite
# two *tracked* files. That makes builds non-reproducible — the same commit
# builds differently from one day to the next — and it is why `make build-all`
# broke with nobody touching this repo: models.dev flipped a model's api to
# "openai-responses" while the pinned generator still stamps the
# completions-only `supportsReasoningEffort` on it (generate-models.ts:1037).
# So we compile the committed catalogs instead, and refresh them deliberately.
#
# TEMPORARY: upstream v0.84.4 ships its own `build:offline` script. At sync
# time, replace the tsgo line above with `npm --workspace packages/ai run
# build:offline` and delete this note. Deliberately kept here rather than in
# patches/ — a Makefile line has zero merge-conflict surface.

refresh-models: ## Deliberately re-fetch live model catalogs (network), then typecheck
	cd $(PI_DIR)/packages/ai && npm run generate-models && npm run generate-image-models
	@echo ">>> typechecking regenerated catalogs"
	cd $(PI_DIR)/packages/ai && npx tsgo -p tsconfig.build.json --noEmit
	@echo ""
	@git diff --stat -- $(PI_DIR)/packages/ai/src/*.generated.ts
	@echo ""
	@echo "Review the diff above before committing. A typecheck failure here means"
	@echo "upstream's generator emitted data its own types reject — do NOT commit."

smoke: ## Quick smoke test of the built binary
	@./bin/gah --version
	@./bin/gah --list-models >/dev/null 2>&1 && echo "list-models OK"
	@echo "smoke: OK"

patches: ## Re-apply patches in patches/
	./scripts/apply-patches.sh

bundle-policy: ## Copy policy pack into dist for publishing (see 0020-bake-policy)
	./scripts/bundle-policy.sh

clean-vendor: ## Discard working-tree changes in vendor/pi
	./scripts/clean-vendor.sh

status: ## Show current vendored upstream ref
	./scripts/sync-upstream.sh status

sync: ## Pull upstream, re-apply patches, rebuild. Usage: make sync REF=v0.85.0
	@test -n "$(REF)" || { echo "usage: make sync REF=<tag-or-branch>"; exit 2; }
	@echo ">>> asserting vendor/pi == upstream + patches before we start"
	./scripts/check-vendor-clean.sh
	@echo ">>> restoring pristine vendor (reverse-applying the patch series)"
	@# This step used to be missing here while docs/WORKFLOW.md and
	@# upstream-sync.yml both required it — so `make sync`, the command a human
	@# is most likely to type, reproduced the CI failure locally every time.
	@for p in $$(ls patches/[0-9]*.patch | sort -r); do \
	  echo "  - reversing $$p" && \
	  git apply -R --directory=$(PI_DIR) $$p || exit 1; \
	done
	git commit -am "sync: restore pristine vendor for $(REF) subtree pull"
	./scripts/sync-upstream.sh pull $(REF)
	./scripts/apply-patches.sh
	git add -A && git commit -m "sync: vendor $(REF), patch series re-applied"
	cd $(PI_DIR) && npm ci
	$(MAKE) build-all
	$(MAKE) smoke
	@echo ""
	@echo "Synced to $(REF); full chain builds and smoke passes. Before merging:"
	@echo "  - review the vendor diff and the scan results"
	@echo "  - re-verify bake-policy by fault injection (docs/WORKFLOW.md)"
	@echo "  - MERGE COMMIT ONLY — never squash (docs/WORKFLOW.md)"

sync-init: ## First-time vendor + install + full build. Usage: make sync-init REF=main
	@test -n "$(REF)" || { echo "usage: make sync-init REF=<tag-or-branch>"; exit 2; }
	./scripts/sync-upstream.sh init $(REF)
	./scripts/apply-patches.sh
	$(MAKE) install
	$(MAKE) build-all

patch-new: ## Open a scratch branch for a new patch. Usage: make patch-new NAME=foo
	@test -n "$(NAME)" || { echo "usage: make patch-new NAME=<short-name>"; exit 2; }
	git checkout -b scratch/$(NAME)
	@echo ""
	@echo "→ On branch scratch/$(NAME)."
	@echo "  1) Edit files under $(PI_DIR)/"
	@echo "  2) git add $(PI_DIR) && git commit -m '...'"
	@echo "  3) make patch-export NAME=$(NAME) NUM=NNNN"

patch-export: ## Export scratch branch as numbered patch. Usage: make patch-export NAME=foo NUM=0002
	@test -n "$(NAME)" -a -n "$(NUM)" || { echo "usage: make patch-export NAME=<name> NUM=<NNNN>"; exit 2; }
	git format-patch -1 --relative=$(PI_DIR) --output=patches/$(NUM)-$(NAME).patch HEAD
	git checkout main
	git branch -D scratch/$(NAME)
	@echo "→ Exported patches/$(NUM)-$(NAME).patch"
	@echo "  Verify round-trip with: make patches"
