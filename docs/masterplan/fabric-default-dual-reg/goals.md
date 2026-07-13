# Goals — fabric-default-dual-reg

topic: make dispatch fabric the default wave path for new seeds and collapse dual pi agent registration to bare-only

## G1: New seeds default to fabric on
signal: test
evidence: buildSeedState default emits dispatch.fabric true; fabricDispatch false omits dispatch; mp seed --fabric=off opt-out covered

## G2: Pi registration is bare-only
signal: test
evidence: register-pi-agents write emits only bare mp-*.md; deletes leftover masterplan:mp-*.md; --check treats leftover colon files as drift; SKIP_FOR_PI unchanged

## G3: Docs and host check match
signal: docs
evidence: verbs/internals/development/AGENTS/CHANGELOG describe seed fabric default and bare-only pi registration; node bin/register-pi-agents.mjs --check exits 0 after resync
