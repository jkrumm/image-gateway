import { describe, expect, test } from 'bun:test'

// enhance.ts -> upstream.ts -> env.ts parses process.env at module load.
process.env['API_SECRET'] ??= 'test-secret'
process.env['OPENAI_BASE_URL'] ??= 'http://localhost:1'
process.env['OPENAI_API_KEY'] ??= 'test-key'

const {
  intentPlaybookKey,
  composeSystemPromptForIntent,
  buildPlanSystemPrompt,
  computeModeApplied,
  buildPlanUserMessage,
  parseLlmPlan,
  snapToNearestPreset,
  resolveSettings,
  extractVerbatimTokens,
  checkVerbatim,
  composeFinalPrompt,
} = await import('./enhance.js')
const { PLAYBOOK } = await import('@image-gateway/shared')

describe('intentPlaybookKey', () => {
  test('maps icon -> icons', () => {
    expect(intentPlaybookKey('icon')).toBe('icons')
  })

  test('matches every other intent 1:1 with its playbook filename', () => {
    for (const intent of [
      'hero',
      'painterly',
      'technical',
      'diagram',
      'article',
      'figure-art',
      'texture',
    ] as const) {
      expect(intentPlaybookKey(intent)).toBe(intent)
    }
  })
})

describe('composeSystemPromptForIntent', () => {
  test('auto omits every intent file (core/settings/policy only)', () => {
    const prompt = composeSystemPromptForIntent('auto')
    expect(prompt).toContain(PLAYBOOK['core'] as string)
    expect(prompt).toContain(PLAYBOOK['settings'] as string)
    expect(prompt).toContain(PLAYBOOK['policy'] as string)
    expect(prompt).not.toContain(PLAYBOOK['icons'] as string)
    expect(prompt).not.toContain(PLAYBOOK['hero'] as string)
  })

  test("intent 'icon' includes the icons.md file (plural mapping)", () => {
    const prompt = composeSystemPromptForIntent('icon')
    expect(prompt).toContain(PLAYBOOK['icons'] as string)
  })

  test("intent 'texture' includes texture.md", () => {
    const prompt = composeSystemPromptForIntent('texture')
    expect(prompt).toContain(PLAYBOOK['texture'] as string)
  })
})

describe('buildPlanSystemPrompt', () => {
  test('appends the output-contract instructions after the playbook content', () => {
    const prompt = buildPlanSystemPrompt('auto')
    expect(prompt).toContain('SINGLE JSON object')
    expect(prompt).toContain('proposed_settings')
    expect(prompt).toContain(PLAYBOOK['core'] as string)
  })
})

function briefOfWords(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(' ')
}

describe('computeModeApplied (aggressiveness gate)', () => {
  test('24 words -> full', () => {
    expect(computeModeApplied({ brief: briefOfWords(24), mode: 'auto' } as never)).toBe('full')
  })

  test('25 words -> gaps (boundary)', () => {
    expect(computeModeApplied({ brief: briefOfWords(25), mode: 'auto' } as never)).toBe('gaps')
  })

  test('100 words -> gaps (boundary)', () => {
    expect(computeModeApplied({ brief: briefOfWords(100), mode: 'auto' } as never)).toBe('gaps')
  })

  test('101 words -> off', () => {
    expect(computeModeApplied({ brief: briefOfWords(101), mode: 'auto' } as never)).toBe('off')
  })

  test("explicit mode: 'off' wins over a short brief", () => {
    expect(computeModeApplied({ brief: briefOfWords(3), mode: 'off' } as never)).toBe('off')
  })

  test("explicit mode: 'full' wins over a long brief", () => {
    expect(computeModeApplied({ brief: briefOfWords(200), mode: 'full' } as never)).toBe('full')
  })

  test('delta-mode iteration gates on the delta word count, not current_prompt', () => {
    const longCurrentPrompt = briefOfWords(200)
    expect(
      computeModeApplied({
        current_prompt: longCurrentPrompt,
        delta: briefOfWords(3),
        mode: 'auto',
      } as never),
    ).toBe('full')
  })
})

describe('buildPlanUserMessage', () => {
  const base = {
    mode: 'auto',
    intent: 'auto',
    series_context: [],
    preserve_list: [],
    has_references: false,
  } as const

  test('brief mode includes the brief text', () => {
    const message = buildPlanUserMessage({ ...base, brief: 'a red lighthouse' } as never, 'full')
    expect(message).toContain('a red lighthouse')
  })

  test('delta mode includes current_prompt, delta, and preserve_list', () => {
    const message = buildPlanUserMessage(
      {
        ...base,
        current_prompt: 'a lighthouse, oil painting',
        delta: 'make it winter',
        preserve_list: ['the lighthouse shape', 'the color palette'],
      } as never,
      'gaps',
    )
    expect(message).toContain('a lighthouse, oil painting')
    expect(message).toContain('make it winter')
    expect(message).toContain('the lighthouse shape')
    expect(message).toContain('the color palette')
  })

  test('fixed intent instructs the model not to redetect', () => {
    const message = buildPlanUserMessage(
      { ...base, brief: 'an icon', intent: 'icon' } as never,
      'full',
    )
    expect(message).toContain('fixed to "icon"')
  })

  test('style guide fragment and palette are included verbatim', () => {
    const message = buildPlanUserMessage(
      {
        ...base,
        brief: 'a hero banner',
        style_guide: {
          prompt_fragment: 'warm editorial tones, soft grain',
          palette: ['#1a2b3c', '#ffffff'],
          avoid: ['neon colors'],
          ref_image_count: 2,
        },
      } as never,
      'full',
    )
    expect(message).toContain('warm editorial tones, soft grain')
    expect(message).toContain('#1a2b3c')
    expect(message).toContain('neon colors')
  })

  test('off mode includes the passthrough instruction', () => {
    const message = buildPlanUserMessage({ ...base, brief: 'a brief' } as never, 'off')
    expect(message).toContain('PASSTHROUGH')
  })
})

describe('parseLlmPlan', () => {
  const validPlan = {
    intent: { detected: 'hero', confidence: 0.9 },
    prompt: 'a lighthouse at dusk',
    additions: [],
    assumptions: [],
    warnings: [],
    proposed_settings: {
      model: 'auto',
      size: 'auto',
      quality: 'auto',
      background: 'auto',
      n: 1,
      moderation: 'auto',
      partial_images: 1,
    },
  }

  test('parses a clean JSON object', () => {
    const result = parseLlmPlan(JSON.stringify(validPlan))
    expect('data' in result).toBe(true)
    if ('data' in result) expect(result.data.prompt).toBe('a lighthouse at dusk')
  })

  test('fence-strips a ```json fenced object', () => {
    const result = parseLlmPlan(`\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\``)
    expect('data' in result).toBe(true)
  })

  test('reports an error for invalid JSON', () => {
    const result = parseLlmPlan('not json at all')
    expect('error' in result).toBe(true)
  })

  test('reports an error for JSON that fails schema validation', () => {
    const result = parseLlmPlan(JSON.stringify({ prompt: 'missing everything else' }))
    expect('error' in result).toBe(true)
  })
})

describe('snapToNearestPreset', () => {
  test('snaps a wide custom size to the wide preset', () => {
    expect(snapToNearestPreset('1536x896')).toBe('1536x1024')
  })

  test('snaps a tall custom size to the tall preset', () => {
    expect(snapToNearestPreset('900x1600')).toBe('1024x1536')
  })

  test('snaps a roughly square custom size to the square preset', () => {
    expect(snapToNearestPreset('1100x1050')).toBe('1024x1024')
  })
})

describe('resolveSettings (capability-matrix correction)', () => {
  /**
   * Both generatable models now have a real alpha channel (live-probed
   * 2026-09-23), so an explicit-model transparent proposal is returned
   * unchanged — no correction, no note. See the xhigh test below for the
   * capability this describe block still does correct.
   */
  test('transparent background is passed through unchanged on a model with an alpha channel', () => {
    const { settings, notes } = resolveSettings({
      proposed: {
        model: 'gpt-image-2.5-flare',
        size: 'auto',
        quality: 'high',
        background: 'transparent',
        n: 1,
        moderation: 'auto',
        partial_images: 1,
      },
      overrides: undefined,
      hasReferences: false,
    })
    expect(settings.model).toBe('gpt-image-2.5-flare')
    expect(settings.background).toBe('transparent')
    expect(notes.some((note) => note.includes('alpha channel'))).toBe(false)
  })

  test('an invalid custom size snaps to the nearest preset and notes it', () => {
    const { settings, notes } = resolveSettings({
      proposed: {
        model: 'gpt-image-2.5-flare',
        size: '1000x1000',
        quality: 'medium',
        background: 'opaque',
        n: 1,
        moderation: 'auto',
        partial_images: 1,
      },
      overrides: undefined,
      hasReferences: false,
    })
    expect(settings.size).toBe('1024x1024')
    expect(notes.some((note) => note.includes('snapped'))).toBe(true)
  })

  test('user overrides are echoed verbatim, taking precedence over the LLM proposal', () => {
    const { settings } = resolveSettings({
      proposed: {
        model: 'gpt-image-2.5-flare',
        size: 'auto',
        quality: 'low',
        background: 'opaque',
        n: 1,
        moderation: 'auto',
        partial_images: 1,
      },
      overrides: { quality: 'high', n: 4 },
      hasReferences: false,
    })
    expect(settings.quality).toBe('high')
    expect(settings.n).toBe(4)
  })

  test('endpoint derives from has_references, not from the LLM', () => {
    const { settings } = resolveSettings({
      proposed: {
        model: 'gpt-image-2.5-flare',
        size: 'auto',
        quality: 'low',
        background: 'opaque',
        n: 1,
        moderation: 'auto',
        partial_images: 1,
      },
      overrides: undefined,
      hasReferences: true,
    })
    expect(settings.endpoint).toBe('edit')
  })

  test('input_fidelity is dropped for a model that rejects it, with a note', () => {
    const { settings, notes } = resolveSettings({
      proposed: {
        model: 'gpt-image-2.5-flare',
        size: 'auto',
        quality: 'high',
        background: 'opaque',
        n: 1,
        moderation: 'auto',
        input_fidelity: 'high',
        partial_images: 1,
      },
      overrides: undefined,
      hasReferences: true,
    })
    expect(settings.input_fidelity).toBeUndefined()
    expect(notes.some((note) => note.includes('input_fidelity'))).toBe(true)
  })

  test('an auto model with a draft quality routes to flare; an edit routes to sunburst', () => {
    const draft = resolveSettings({
      proposed: {
        model: 'auto',
        size: 'auto',
        quality: 'low',
        background: 'opaque',
        n: 4,
        moderation: 'auto',
        partial_images: 1,
      },
      overrides: undefined,
      hasReferences: false,
    })
    expect(draft.settings.model).toBe('gpt-image-2.5-flare')

    const edit = resolveSettings({
      proposed: {
        model: 'auto',
        size: 'auto',
        quality: 'low',
        background: 'opaque',
        n: 1,
        moderation: 'auto',
        partial_images: 1,
      },
      overrides: undefined,
      hasReferences: true,
    })
    expect(edit.settings.model).toBe('gpt-image-2.5-sunburst')
  })
})

describe('extractVerbatimTokens / checkVerbatim', () => {
  test('extracts quoted strings, hex colors, and numbers', () => {
    const tokens = extractVerbatimTokens('Headline: "SUMMER SALE" in #1a2b3c, exactly 3 stars')
    expect(tokens).toContain('SUMMER SALE')
    expect(tokens).toContain('#1a2b3c')
    expect(tokens).toContain('3')
  })

  test('skips the first word when scanning for capitalized proper nouns', () => {
    const tokens = extractVerbatimTokens('A lighthouse near Kyoto at dusk')
    expect(tokens).toContain('Kyoto')
    expect(tokens).not.toContain('A')
  })

  test('checkVerbatim reports ok when every token survives', () => {
    const result = checkVerbatim(
      'a lighthouse near Kyoto with "SUMMER SALE" text',
      'a lighthouse near Kyoto at dusk with "SUMMER SALE" painted on the door',
    )
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
  })

  test('checkVerbatim reports missing hex colors and quoted strings', () => {
    const result = checkVerbatim(
      'a logo in #1a2b3c with the text "ACME"',
      'a logo, blue and clean, with some text on it',
    )
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('#1a2b3c')
    expect(result.missing).toContain('ACME')
  })
})

describe('composeFinalPrompt (passthrough enforcement)', () => {
  test('non-off mode trusts the LLM prompt as-is', () => {
    const prompt = composeFinalPrompt({
      modeApplied: 'full',
      request: { brief: 'the raw brief' } as never,
      llmPrompt: 'a fully enhanced prompt',
      constraintBlock: undefined,
    })
    expect(prompt).toBe('a fully enhanced prompt')
  })

  test('off mode ignores the LLM prompt and uses the raw brief unchanged', () => {
    const prompt = composeFinalPrompt({
      modeApplied: 'off',
      request: { brief: 'the raw brief, expert-crafted' } as never,
      llmPrompt: 'an LLM rewrite that should be discarded',
      constraintBlock: undefined,
    })
    expect(prompt).toBe('the raw brief, expert-crafted')
  })

  test('off mode appends an LLM-suggested constraint block', () => {
    const prompt = composeFinalPrompt({
      modeApplied: 'off',
      request: { brief: 'the raw brief' } as never,
      llmPrompt: 'discarded',
      constraintBlock: 'Preserve exact composition.',
    })
    expect(prompt).toBe('the raw brief\n\nPreserve exact composition.')
  })

  test('off mode with current_prompt (delta re-run) uses current_prompt, not brief', () => {
    const prompt = composeFinalPrompt({
      modeApplied: 'off',
      request: { current_prompt: 'the established prompt' } as never,
      llmPrompt: 'discarded',
      constraintBlock: undefined,
    })
    expect(prompt).toBe('the established prompt')
  })
})
