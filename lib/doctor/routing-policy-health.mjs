// Report fresh C1 discovery, never selected models or inferred provider health.
import { discoverDispatchMap, resolvePhase, resolveUsecase } from '../dispatch/routing-policy.mjs';
import { readEnv } from '../config.mjs';

const ID = 'routing-policy-health';
const FIX = 'provide a valid delivered C1 dispatch-map.json or set MP_DISPATCH_MAP; unset retired MP_ROUTING_POLICY and migrate model choices to inference routing';
const REQUIRED_PHASES = ['implement', 'plan', 'challenge'];

export function check(repoRoot, opts = {}) {
  try {
    const discovery = discoverDispatchMap({ host: opts.host ?? (readEnv('PI_CODING_AGENT') === 'true' ? 'pi' : 'claude-code'),
      homeDir: opts.homeDir ?? readEnv('HOME'),
      ...(opts.readFile ? { readFile: opts.readFile } : {}),
      env: opts.policyPath !== undefined ? { ...(opts.env ?? {}), MP_DISPATCH_MAP: opts.policyPath } : opts.env });
    if (discovery.status === 'unconfigured') return [{ id: ID, severity: 'PASS',
      summary: 'C1 discovery unconfigured: supported host-native execution (path/schema absent)', fix: null }];
    for (const phase of REQUIRED_PHASES) resolvePhase(phase, { policy: discovery.policy });
    resolveUsecase('bounded-edit', { policy: discovery.policy });
    return [{ id: ID, severity: 'PASS', summary: `C1 discovery configured at ${discovery.path} (schema ${discovery.schema}; phase/usecase/agent references valid)`, fix: null }];
  } catch (error) {
    return [{ id: ID, severity: 'ERROR', summary: `C1 discovery failed: ${error.message}`, fix: FIX }];
  }
}
