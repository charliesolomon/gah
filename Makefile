# GAH top-level workflow. Run `make` (or `make help`) for the command list.
#
# The recipes wrap scripts/* and the upstream PI build so that the day-to-day
# loop fits on a single screen and no one has to remember where each step lives.

PI_DIR := vendor/pi

.DEFAULT_GOAL := help
.PHONY: help install install-hooks build build-all smoke patches bundle-policy clean-vendor sync sync-init status patch-new patch-export

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

build-all: ## Full build chain: tui → ai → agent → coding-agent
	cd $(PI_DIR) && for p in tui ai agent coding-agent; do \
	  echo ">>> building $$p" && \
	  npm --workspace packages/$$p run build || exit 1; \
	done

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

sync: ## Pull upstream, re-apply patches, rebuild. Usage: make sync REF=v0.75.0
	@test -n "$(REF)" || { echo "usage: make sync REF=<tag-or-branch>"; exit 2; }
	./scripts/sync-upstream.sh pull $(REF)
	./scripts/apply-patches.sh
	$(MAKE) build

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
