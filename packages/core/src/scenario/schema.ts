import { z } from 'zod';

/** How a step or assertion points at an element. A bare string is a Playwright selector (CSS, text=, role=, etc.). */
export const TargetSchema = z.union([
  z.string(),
  z.object({ role: z.string(), name: z.string().optional(), exact: z.boolean().optional() }).strict(),
  z.object({ text: z.string(), exact: z.boolean().optional() }).strict(),
  z.object({ label: z.string() }).strict(),
  z.object({ testId: z.string() }).strict(),
  z.object({ placeholder: z.string() }).strict(),
  z.object({ selector: z.string() }).strict(),
]);
export type Target = z.infer<typeof TargetSchema>;

const Times = z.union([z.number().int().nonnegative(), z.string().regex(/^(>=|<=|>|<|==|=)?\s*\d+$/)]);

export const AssertionSchema = z.union([
  z.object({ visible: TargetSchema, timeout: z.number().optional() }).strict(),
  z.object({ hidden: TargetSchema, timeout: z.number().optional() }).strict(),
  z
    .object({
      text: z.object({
        target: TargetSchema.optional(),
        contains: z.string().optional(),
        equals: z.string().optional(),
        matches: z.string().optional(),
      }).strict(),
      timeout: z.number().optional(),
    })
    .strict(),
  z.object({ url: z.string(), timeout: z.number().optional() }).strict(),
  z.object({ title: z.string(), timeout: z.number().optional() }).strict(),
  z.object({ eval: z.string(), timeout: z.number().optional() }).strict(),
  z
    .object({
      request: z.object({ method: z.string().optional(), url: z.string(), times: Times.optional(), status: z.number().optional() }).strict(),
      timeout: z.number().optional(),
    })
    .strict(),
  z.object({ console: z.object({ errors: z.number().optional(), warnings: z.number().optional() }).strict() }).strict(),
  z
    .object({
      media: z
        .object({
          selector: z.string().optional(),
          time: z.number().optional(),
          tolerance: z.number().optional(),
          gte: z.number().optional(),
          lte: z.number().optional(),
          paused: z.boolean().optional(),
        })
        .strict(),
      timeout: z.number().optional(),
    })
    .strict(),
  z.object({ judge: z.string(), threshold: z.enum(['warn', 'fail']).optional() }).strict(),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

const FillSchema = z.object({ target: TargetSchema, value: z.string() }).strict();
const WaitSchema = z.union([
  z.number(),
  z.object({ selector: z.string(), state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(), timeout: z.number().optional() }).strict(),
  z.object({ ms: z.number() }).strict(),
  z.object({ url: z.string(), timeout: z.number().optional() }).strict(),
  z.object({ load: z.enum(['load', 'domcontentloaded', 'networkidle']) }).strict(),
  z.object({ request: z.string(), method: z.string().optional(), timeout: z.number().optional() }).strict(),
]);
const MediaActionSchema = z
  .object({
    selector: z.string().optional(),
    play: z.boolean().optional(),
    pause: z.boolean().optional(),
    seek: z.number().optional(),
    muted: z.boolean().optional(),
    /** Block until media currentTime >= this many seconds. */
    waitForTime: z.number().optional(),
    timeout: z.number().optional(),
  })
  .strict();
const ApiSchema = z
  .object({
    method: z.string().default('GET'),
    url: z.string(),
    data: z.unknown().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    expectStatus: z.number().optional(),
  })
  .strict();
const CaptureSchema = z.union([z.string(), z.object({ name: z.string(), fullPage: z.boolean().optional() }).strict()]);
const FlagValue = z.union([z.boolean(), z.string(), z.number()]);

export const StepSchema = z
  .object({
    id: z.string().optional(),
    chapter: z.string().optional(),
    // navigation
    goto: z.string().optional(),
    reload: z.boolean().optional(),
    back: z.boolean().optional(),
    // interaction
    click: TargetSchema.optional(),
    dblclick: TargetSchema.optional(),
    hover: TargetSchema.optional(),
    fill: FillSchema.optional(),
    press: z.union([z.string(), z.object({ target: TargetSchema.optional(), key: z.string() }).strict()]).optional(),
    select: z.object({ target: TargetSchema, value: z.string() }).strict().optional(),
    check: TargetSchema.optional(),
    uncheck: TargetSchema.optional(),
    // environment
    flag: z.record(z.string(), FlagValue).optional(),
    signIn: z.string().optional(),
    signOut: z.boolean().optional(),
    api: ApiSchema.optional(),
    // scripting
    eval: z.string().optional(),
    evaluate: z.string().optional(),
    media: MediaActionSchema.optional(),
    sleep: z.number().optional(),
    /** Natural-language step. Compiled once (LLM-assisted) into cached code; runs never call the LLM. */
    do: z.string().optional(),
    // waiting / evidence
    wait: WaitSchema.optional(),
    waitFor: WaitSchema.optional(),
    capture: CaptureSchema.optional(),
    screenshot: CaptureSchema.optional(),
    expect: z.array(AssertionSchema).optional(),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;

export const VariantSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i),
    title: z.string().optional(),
    covers: z.array(z.string()).optional(),
    persona: z.string().optional(),
    flags: z.record(z.string(), FlagValue).optional(),
    fixtures: z.record(z.string(), z.string()).optional(),
    tags: z.array(z.string()).optional(),
    /** Replace the `expect` list of the last step whose expectations aren't only console checks. */
    override_last_expect: z.array(AssertionSchema).optional(),
    /** Patch steps by id. `expect` replaces; other keys merge. */
    override_steps: z.record(z.string(), StepSchema.partial()).optional(),
    skip_steps: z.array(z.string()).optional(),
  })
  .strict();
export type Variant = z.infer<typeof VariantSchema>;

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i, 'id must be a slug'),
    title: z.string(),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    covers: z.array(z.string()).default([]),
    persona: z.string().default('anonymous'),
    flags: z.record(z.string(), FlagValue).default({}),
    viewport: z.object({ width: z.number(), height: z.number() }).optional(),
    baseURL: z.string().optional(),
    fixtures: z.record(z.string(), z.string()).default({}),
    setup: z.array(StepSchema).default([]),
    steps: z.array(StepSchema).min(1),
    variants: z.array(VariantSchema).default([]),
    redact: z.array(z.string()).default([]),
    timeout: z.number().optional(),
  })
  .strict();
export type ScenarioInput = z.input<typeof ScenarioSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

/** A scenario with a variant applied: one runnable unit, one evidence bundle. */
export interface ResolvedScenario {
  /** `video-resume` or `video-resume/flag-off` */
  key: string;
  scenarioId: string;
  variantId?: string;
  title: string;
  description?: string;
  tags: string[];
  covers: string[];
  persona: string;
  flags: Record<string, boolean | string>;
  viewport?: { width: number; height: number };
  baseURL?: string;
  fixtures: Record<string, string>;
  setup: Step[];
  steps: Step[];
  redact: string[];
  timeout?: number;
  sourceFile?: string;
  /** sha256 of the canonical resolved scenario */
  hash: string;
}
