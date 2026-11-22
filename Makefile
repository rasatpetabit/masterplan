.PHONY: test test-joint help

help:
	@echo "Available targets:"
	@echo "  make test       - run the standalone unit suite (npm test; MASTERPLAN_STANDALONE_CI=1)"
	@echo "  make test-joint - run the joint suite that requires W (npm run test:joint)"

test:
	@npm test

test-joint:
	@npm run test:joint
