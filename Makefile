# GAH top-level workflow. Run `make` (or `make help`) for the command list.
#
# The recipes wrap scripts/* and the upstream PI build so that the day-to-day
# loop fits on a single screen and no one has to remember where each step lives.

PI_DIR := vendor/pi

.DEFAULT_GOAL := help
.PHONY: help install install-tools install-hooks build build-all build-offline smoke refresh-model-data patches bundle-policy clean-vendor sync sync-init status patch-new patch-export

help: ## Show available targets
	@awk 'BEGIN { FS = ":.*##"; printf "Usage: make <target> [VAR=value]\n\nTargets:\n" } \
	      /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' \
	      $(MAKEFILE_LIST)

install: ## Install npm deps in vendor/pi (run after first sync-init)
	cd $(PI_DIR) && npm install

install-tools: ## Install pinned, SHA-256-verified fd + ripgrep into ~/.gah/agent/bin (see docs/SUPPLY-CHAIN.md)
	@# 0013-offline-runtime removed upstream's runtime download of these; the
	@# find and grep tools need them. Offline: see the doc for --download-only/--from.
	node scripts/install-tools.mjs

install-hooks: ## Symlink scripts/git-hooks/* into .git/hooks/ (one-time per clone)
	@for hook in scripts/git-hooks/*; do \
	  name=$$(basename $$hook); \
	  ln -sf ../../$$hook .git/hooks/$$name && echo "✓ .git/hooks/$$name → $$hook"; \
	done

build: ## Incremental build of coding-agent (after patch edits)
	cd $(PI_DIR) && npm --workspace packages/coding-agent run build

build-all: ## Full build chain (upstream's own script — 9 packages at v0.84.4)
	@# Run upstream's chain verbatim rather than mirroring it. Ours listed 4
	@# packages while upstream had grown to 9, so `make build-all` silently built
	@# a subset — the same class of invisible drift that broke the sync for
	@# 15 weeks. Deriving it from vendor/pi means it cannot go stale again.
	@#
	@# No network: 0030-offline-model-data replaces upstream's catalogue fetch
	@# with scripts/gah-model-data.ts, which seeds src/providers/data/ from
	@# packages/policy-pack/model-data and ships every other provider empty.
	@# Refresh the seed with `make refresh-model-data` (that step does fetch).
	cd $(PI_DIR) && npm run build

build-offline: ## Rebuild reusing src/providers/data as-is (needs a prior build-all)
	@# Upstream's build:offline validates whatever is in src/providers/data
	@# instead of re-materialising it. Since 0030 a normal build-all is offline
	@# too; this only skips the seed step, and is what you want after
	@# `npm run hydrate:model-data` to build against a full hydration.
	cd $(PI_DIR)/packages/ai && npm run build:offline
	cd $(PI_DIR) && npm --workspace packages/coding-agent run build

smoke: ## Quick smoke test of the built binary
# GAH_ALLOW_NO_SKILLS: this exercises the harness, not an organization's skills
# repo, so it opts out of the check bin/gah makes for one.
	@GAH_ALLOW_NO_SKILLS=1 ./bin/gah --version
	@GAH_ALLOW_NO_SKILLS=1 ./bin/gah --list-models >/dev/null 2>&1 && echo "list-models OK"
	@# 0030: the shipped catalogue must be exactly the seed — nothing fetched,
	@# nothing dropped. Non-empty data files in dist vs. the seed directory.
	@shipped=$$(cd $(PI_DIR)/packages/ai/dist/providers/data && for f in *.json; do [ "$$(cat $$f)" != "{}" ] && echo $$f; done | sort); \
	seeded=$$(ls packages/policy-pack/model-data/*.json | xargs -n1 basename | sort); \
	if [ "$$shipped" != "$$seeded" ]; then \
	  echo "smoke: shipped model data differs from packages/policy-pack/model-data" >&2; \
	  echo "  shipped: $$shipped" >&2; echo "  seeded:  $$seeded" >&2; exit 1; \
	fi; echo "model data == seed OK"
	@echo "smoke: OK"

refresh-model-data: ## Re-hydrate the seeded providers from the vendor APIs (network) into packages/policy-pack/model-data
	@# The one step in this repo that talks to the model vendors. Hydrates every
	@# provider upstream-style, then copies back only the files the seed already
	@# carries. Adding a provider is a deliberate manual copy -- see the README.
	cd $(PI_DIR) && npm run hydrate:model-data
	@for f in packages/policy-pack/model-data/*.json; do \
	  name=$$(basename $$f); \
	  cp "$(PI_DIR)/packages/ai/src/providers/data/$$name" "$$f" && echo "✓ refreshed $$name"; \
	done
	@git diff --stat -- packages/policy-pack/model-data
	@echo "Review the diff like any policy change, then: make build-all"

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
