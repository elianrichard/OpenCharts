# OpenCharts — common tasks.
#
#   make            list the targets
#   make stocks     run the US-stock workspace (Alpaca) at http://localhost:5173
#
# Alpaca keys are read by the dev server only (never bundled): from .env.local,
# else from ../trading-script/.env. See docs/STOCKS.md.

PORT ?= 5173
HOST ?= localhost
URL := http://$(HOST):$(PORT)

.DEFAULT_GOAL := help
.PHONY: help install stocks stocks-open demo build-stocks preview-stocks scan scan-status \
	test test-stocks typecheck lint check clean-cache

help: ## Show this list
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

node_modules: package.json
	npm install
	@touch node_modules

stocks: node_modules ## Run the stock workspace (PORT=5173 by default)
	VITE_ADAPTER=alpaca npx vite --host $(HOST) --port $(PORT) --strictPort

stocks-open: node_modules ## Run the stock workspace and open it in the browser
	VITE_ADAPTER=alpaca npx vite --host $(HOST) --port $(PORT) --strictPort --open

demo: node_modules ## Run the original crypto demo
	VITE_ADAPTER=demo npx vite --host $(HOST) --port $(PORT) --strictPort

build-stocks: node_modules ## Production build of the stock workspace (dist/)
	VITE_ADAPTER=alpaca npx vite build

preview-stocks: build-stocks ## Build, then serve dist/ with the Alpaca proxy
	VITE_ADAPTER=alpaca npx vite preview --host $(HOST) --port $(PORT) --strictPort

scan: ## Re-run the 150-symbol scans on a running server
	@curl -sf "$(URL)/stocks-api/scans?refresh=1&wait=0" >/dev/null \
		&& echo "Scan started. Progress: make scan-status" \
		|| echo "No server at $(URL). Start it with: make stocks"

scan-status: ## Show scan progress on a running server
	@curl -sf "$(URL)/stocks-api/scans/status" && echo \
		|| echo "No server at $(URL). Start it with: make stocks"

test: node_modules ## Run all unit tests
	npx vitest run

test-stocks: node_modules ## Run the stock workspace tests (scans, data, UI)
	npx vitest run src/stocks

typecheck: node_modules ## Type-check the project
	npx tsc --noEmit

lint: node_modules ## Lint src/
	npx eslint src/

check: typecheck lint test ## Type-check, lint and test

clean-cache: ## Delete the cached Alpaca bars and scan report (next scan is a cold run, ~30 s)
	rm -rf .cache/stocks
