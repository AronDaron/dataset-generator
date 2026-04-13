/**
 * Maps OpenRouter model ID prefixes to locally cached provider logo SVGs.
 * Icons from https://github.com/glincker/thesvg, stored in /public/provider-icons/
 *
 * Selection notes:
 *   dark.svg  — white/light icon, best for dark backgrounds
 *   color.svg — brand colors, works on dark backgrounds
 *   default.svg — often black-on-transparent, needs light-ish background
 */
const ICON_MAP: Record<string, string> = {
  // Major model creators
  anthropic:        '/provider-icons/anthropic.svg',    // dark.svg (white)
  openai:           '/provider-icons/openai.svg',       // dark.svg (white)
  google:           '/provider-icons/google.svg',       // color.svg
  'meta-llama':     '/provider-icons/meta.svg',         // color.svg
  mistralai:        '/provider-icons/mistral.svg',      // color.svg
  mistral:          '/provider-icons/mistral.svg',
  deepseek:         '/provider-icons/deepseek.svg',     // color.svg
  qwen:             '/provider-icons/qwen.svg',         // dark.svg (white)
  cohere:           '/provider-icons/cohere.svg',       // color.svg
  nvidia:           '/provider-icons/nvidia.svg',       // dark.svg (white)
  groq:             '/provider-icons/groq.svg',         // default.svg
  'x-ai':           '/provider-icons/xai.svg',          // default.svg
  together:         '/provider-icons/together.svg',     // dark.svg (white)
  perplexity:       '/provider-icons/perplexity.svg',   // default.svg
  'perplexity-ai':  '/provider-icons/perplexity.svg',

  // Z.ai (Zhipu / GLM models)
  'z-ai':           '/provider-icons/zdotai.svg',

  // Chinese AI companies
  minimax:          '/provider-icons/minimax.svg',
  baidu:            '/provider-icons/baidu.svg',        // color.svg
  'bytedance-seed': '/provider-icons/bytedance.svg',   // color.svg
  bytedance:        '/provider-icons/bytedance.svg',
  moonshotai:       '/provider-icons/kimi.svg',         // color.svg (Moonshot's product)
  moonshot:         '/provider-icons/moonshot.svg',
  xiaomi:           '/provider-icons/xiaomi.svg',
  tencent:          '/provider-icons/tencent.svg',      // color.svg
  kwaipilot:        '/provider-icons/kwaipilot.svg',    // color.svg

  // Western AI companies
  microsoft:        '/provider-icons/microsoft.svg',    // color.svg
  amazon:           '/provider-icons/amazon.svg',
  inflection:       '/provider-icons/inflection.svg',   // dark.svg (white)
  'ai21':           '/provider-icons/ai21.svg',
  'ibm-granite':    '/provider-icons/ibm-granite.svg',
  liquid:           '/provider-icons/liquid.svg',
  inception:        '/provider-icons/inception.svg',
  'inception-labs': '/provider-icons/inception.svg',
  upstage:          '/provider-icons/upstage.svg',      // color.svg
  'aion-labs':      '/provider-icons/aion-labs.svg',    // color.svg
  nousresearch:     '/provider-icons/nousresearch.svg',
}

/** Returns the icon URL for a given OpenRouter model ID, or undefined if unknown. */
export function getProviderIcon(modelId: string): string | undefined {
  const prefix = modelId.split('/')[0]
  return prefix ? ICON_MAP[prefix] : undefined
}
