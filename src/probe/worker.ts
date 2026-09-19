import { subscriptionRuntime } from '../pi/auth.ts';
import { COMPATIBLE_PROVIDER } from '../pi/compatible.ts';
import { compatibleRuntime } from './auth.ts';
import type { ProbeRoute } from './args.ts';
import { probeRound, probeTool } from './round.ts';
import { SUBSCRIPTION_TARGET } from './session.ts';
// argv: root, route JSON (no secrets), session file or '', operation.
try {
  const [root, json, file, op] = process.argv.slice(2) as [string, string, string, string];
  const route = JSON.parse(json) as ProbeRoute;
  const runtime = route.kind === 'subscription'
    ? await subscriptionRuntime(root, route.authPath, SUBSCRIPTION_TARGET.provider) : await compatibleRuntime(root, route);
  const target = route.kind === 'subscription' ? SUBSCRIPTION_TARGET : { provider: COMPATIBLE_PROVIDER, model: route.model };
  const result = op === 'tool'
    ? await probeTool(root, runtime, undefined, target)
    : await probeRound(root, runtime, file || undefined, undefined, target);
  process.send?.(result);
} catch { process.exitCode = 1; }
finally { process.disconnect?.(); }
