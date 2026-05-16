.PHONY: test test-static test-doctor-fixtures test-python test-e2e help

help:
	@echo "Available targets:"
	@echo "  make test                 - run all tests (static + doctor-fixtures + python; NO e2e)"
	@echo "  make test-static          - run static / structural test battery (fast, pre-commit grade)"
	@echo "  make test-doctor-fixtures - run extracted doctor checks against fixture corpus"
	@echo "  make test-python          - run pytest test suite in tests/"
	@echo "  make test-e2e             - run /masterplan e2e tests via claude --print (opt-in, costs USD)"
	@echo "                              honors CLAUDE_E2E_MODEL (default: sonnet),"
	@echo "                              CLAUDE_E2E_BUDGET (default: 3.00), CLAUDE_E2E_TIMEOUT (default: 480)"

test: test-static test-doctor-fixtures test-python

test-static:
	@bash tests/run-static.sh

test-doctor-fixtures:
	@bash tests/doctor-fixtures/run.sh

test-python:
	@cd tests && python3 -m unittest discover -p 'test_*.py' -v

test-e2e:
	@CLAUDE_E2E=1 bash tests/e2e/run.sh
