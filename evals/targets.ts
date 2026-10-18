// Which guardrail to scan with. Region and profile come from the names the sandbox and
// scripts/e2e.sh use, and reach the hooks as the plugin options Claude Code would set.

// The profile the sandbox and the nophi launcher use when none is exported.
const DEFAULT_PROFILE = 'phi-guard';

export interface Target {
  name: string;
  guardrailId: string;
  version: string;
}

/** Parses `<name>=<guardrailId>:<version>`, splitting on the last colon because a guardrail ARN has colons. */
export function parseTarget(spec: string): Target {
  const equals = spec.indexOf('=');
  const colon = spec.lastIndexOf(':');
  if (equals < 1 || colon < equals + 2 || colon === spec.length - 1) {
    throw new Error(`--target must look like <name>=<guardrailId>:<version>, got ${JSON.stringify(spec)}`);
  }
  return { name: spec.slice(0, equals), guardrailId: spec.slice(equals + 1, colon), version: spec.slice(colon + 1) };
}

export function defaultTarget(env: NodeJS.ProcessEnv): Target | undefined {
  const { PHI_GUARD_GUARDRAIL_ID: guardrailId, PHI_GUARD_GUARDRAIL_VERSION: version } = env;
  return guardrailId && version ? { name: 'default', guardrailId, version } : undefined;
}

/** The environment a hook process runs in. A missing region reaches the hook, which fails closed and names it. */
export function hookEnv(target: Target, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    CLAUDE_PLUGIN_OPTION_GUARDRAIL_ID: target.guardrailId,
    CLAUDE_PLUGIN_OPTION_GUARDRAIL_VERSION: target.version,
    CLAUDE_PLUGIN_OPTION_AWS_REGION: env.PHI_GUARD_AWS_REGION,
    CLAUDE_PLUGIN_OPTION_AWS_PROFILE: env.PHI_GUARD_AWS_PROFILE || DEFAULT_PROFILE,
  };
}
