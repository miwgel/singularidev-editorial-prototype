import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { audit } from '../../editorial.mjs';

// Loaded explicitly by app.mjs. Credentials come only from the local environment.
export default function (pi: ExtensionAPI) {
  const baseUrl = process.env.BISTE_LLM_BASE_URL;
  if (!baseUrl) throw Error('Configura BISTE_LLM_BASE_URL con la URL de tu servicio compatible con Responses.');
  pi.registerProvider('biste', {
    name: 'Servicio LLM configurable',
    baseUrl,
    api: 'openai-responses',
    apiKey: '$BISTE_LLM_API_KEY',
    models: [{
      id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', input: ['text'], reasoning: true,
      // Conservative application limits, not claims about the service maximum.
      contextWindow: 64000, maxTokens: 8192,
      // Required Pi metadata; actual proxy prices are unknown. app.mjs records
      // cost=null and unknown_proxy_tariff instead of treating this as free use.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  pi.on('before_provider_request', event => {
    const payload = event.payload as { model?: string; reasoning?: { effort?: string }; max_output_tokens?: number };
    audit('llm_request', { provider: 'biste', model: payload.model, thinking: payload.reasoning?.effort,
      maxOutputTokens: payload.max_output_tokens, costStatus: 'unknown_proxy_tariff' });
  });
}
