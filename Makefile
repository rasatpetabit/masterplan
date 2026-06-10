.PHONY: test help

help:
	@echo "Available targets:"
	@echo "  make test - run the unit suite (node --test test/*.test.mjs)"

test:
	@npm test
