.PHONY: test test-static test-python help

help:
	@echo "Available targets:"
	@echo "  make test         - run all tests (static + python)"
	@echo "  make test-static  - run static / structural test battery (fast, pre-commit grade)"
	@echo "  make test-python  - run pytest test suite in tests/"

test: test-static test-python

test-static:
	@bash tests/run-static.sh

test-python:
	@cd tests && python3 -m unittest discover -p 'test_*.py' -v
