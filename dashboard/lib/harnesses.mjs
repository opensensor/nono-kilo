import { RequestError } from './core.mjs';

export const HARNESSES = Object.freeze({
  kilo: { name: 'Kilo', profile: 'default' },
  claude: { name: 'Claude Code', profile: 'nolabs-ai/claude' },
  codex: { name: 'Codex CLI', profile: 'nolabs-ai/codex' }
});

export function validateHarness(value) {
  if (!Object.hasOwn(HARNESSES, value)) throw new RequestError('Choose Kilo, Claude Code, or Codex CLI.');
  return value;
}

export function validateOptionalModel(value) {
  if (typeof value !== 'string' || (value && !/^[a-zA-Z0-9_~][a-zA-Z0-9_~./:@+-]{0,255}$/.test(value))) throw new RequestError('Use a model ID without spaces or command options.');
  return value;
}

export function configuredModel(settings, harness = settings.harness || 'kilo') {
  return harness === 'kilo' ? settings.defaultModel : settings.nativeModels?.[harness] || '';
}

export function buildAgentCommand({ harness = 'kilo', prompt = '', model = '', autoApprove = false, interactive = false }, binaries) {
  validateHarness(harness);
  if (typeof prompt !== 'string' || prompt.length > 12000 || (!interactive && !prompt.trim())) throw new RequestError('Batch tasks need a prompt of up to 12,000 characters.');
  validateOptionalModel(model);
  if (typeof autoApprove !== 'boolean' || typeof interactive !== 'boolean') throw new RequestError('Invalid session approval or mode.');
  const binary = binaries[harness];
  if (!binary) throw new RequestError(`${HARNESSES[harness].name} is not configured on this host.`);
  if (harness === 'kilo') {
    if (!model) throw new RequestError('Choose a Kilo model.');
    return [binary, ...(interactive ? ['--pure', '--model', model, ...(autoApprove ? ['--auto'] : []), ...(prompt.trim() ? [`--prompt=${prompt.trim()}`] : [])]
      : ['run', '--pure', '--model', model, '--title', prompt.trim().slice(0, 80), ...(autoApprove ? ['--auto'] : []), '--', prompt.trim()])];
  }
  if (harness === 'claude') return [binary, ...(interactive ? [] : ['--print', '--permission-prompts', 'none']),
    ...(model ? ['--model', model] : []), ...(autoApprove ? ['--dangerously-skip-permissions'] : []),
    ...(prompt.trim() ? ['--', prompt.trim()] : [])];
  if (!interactive && !autoApprove) throw new RequestError('Codex batch tasks need auto approval. Use an interactive terminal to answer tool prompts.');
  return [binary, '--sandbox', 'danger-full-access', '--ask-for-approval', autoApprove ? 'never' : 'on-request',
    ...(model ? ['--model', model] : []), ...(interactive ? [] : ['exec']), ...(prompt.trim() ? ['--', prompt.trim()] : [])];
}
