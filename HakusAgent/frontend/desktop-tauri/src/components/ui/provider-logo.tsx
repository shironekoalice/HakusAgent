/**
 * ProviderLogo — renders the brand icon for a given provider id.
 *
 * Uses @lobehub/icons (open-source SVG icon collection) instead of
 * hand-drawn icons. Each provider gets its real brand logo.
 *
 * The icons are React components that accept `size`, `className`, etc.
 * We default to the "Mono" (single-color) variant so the icon adapts
 * to the current text color. For providers that have a brand color,
 * we could use the "Color" variant instead — but mono keeps the UI
 * consistent with the blue accent theme.
 */
import { memo } from 'react'
import {
  AlibabaCloud,
  OpenAI,
  DeepSeek,
  Anthropic,
  Arcee,
  AtlasCloud,
  Antigravity,
  Baidu,
  DeepInfra,
  Fireworks,
  Qwen,
  Gemini,
  Google,
  HuggingFace,
  Kimi,
  LongCat,
  Meta,
  Minimax,
  Mistral,
  Moonshot,
  Novita,
  Nvidia,
  Ollama,
  OpenCode,
  OpenRouter,
  Stepfun,
  Together,
  Volcengine,
  Vllm,
  XAI,
  Zhipu,
  XiaomiMiMo,
} from '@lobehub/icons'

/** Map provider id → lobehub icon component. */
const PROVIDER_ICONS: Record<string, React.ComponentType<any>> = {
  // First-party and hosted routes
  'modelstudio-token-plan': AlibabaCloud,
  'modelstudio-token-plan-anthropic': AlibabaCloud,
  'modelstudio-coding-plan': AlibabaCloud,
  'modelstudio-coding-plan-anthropic': AlibabaCloud,
  openai: OpenAI,
  deepseek: DeepSeek,
  'deepseek-anthropic': DeepSeek,
  anthropic: Anthropic,
  claude: Anthropic,
  antigravity: Antigravity,
  google: Google,
  qwen: Qwen,
  gemini: Gemini,
  arcee: Arcee,
  atlascloud: AtlasCloud,
  qianfan: Baidu,
  baidu: Baidu,
  deepinfra: DeepInfra,
  fireworks: Fireworks,
  huggingface: HuggingFace,
  kimi: Kimi,
  longcat: LongCat,
  meta: Meta,
  minimax: Minimax,
  'minimax-anthropic': Minimax,
  mistral: Mistral,
  moonshot: Moonshot,
  novita: Novita,
  'nvidia-nim': Nvidia,
  ollama: Ollama,
  'ollama-cloud': Ollama,
  opencode: OpenCode,
  'opencode-go': OpenCode,
  'opencode-zen': OpenCode,
  openrouter: OpenRouter,
  orcarouter: OpenRouter,
  stepfun: Stepfun,
  together: Together,
  volcengine: Volcengine,
  'siliconflow': OpenAI,
  'siliconflow-cn': OpenAI,
  sglang: Vllm,
  vllm: Vllm,
  xai: XAI,
  glm: Zhipu,
  zhipu: Zhipu,
  chatglm: Zhipu,
  zai: Zhipu,
  mimo: XiaomiMiMo,
  'xiaomi-mimo': XiaomiMiMo,
}

interface ProviderLogoProps {
  /** Provider id (e.g. "openai", "deepseek", "glm"). */
  providerId: string
  /** Icon size in pixels. Default 16. */
  size?: number
  /** Extra className for the icon. */
  className?: string
}

/**
 * Render a provider's brand icon. Unknown custom routes keep a quiet,
 * neutral initial badge so they do not compete with the selected state.
 */
function ProviderLogoImpl({ providerId, size = 16, className }: ProviderLogoProps) {
  const Icon = PROVIDER_ICONS[providerId?.toLowerCase()]
  if (Icon) {
    return <Icon size={size} className={className} />
  }
  // Fallback: first letter in a neutral badge. Custom routes do not have a
  // trustworthy brand mark, so avoid borrowing the primary accent here.
  const letter = (providerId || '?').charAt(0).toUpperCase()
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: Math.max(4, Math.round(size * 0.28)),
        fontSize: size * 0.6,
        fontWeight: 600,
        backgroundColor: 'hsl(var(--muted) / 0.72)',
        color: 'hsl(var(--muted-foreground))',
        lineHeight: 1,
      }}
    >
      {letter}
    </span>
  )
}

export const ProviderLogo = memo(ProviderLogoImpl)
