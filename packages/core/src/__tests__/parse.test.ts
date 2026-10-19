import { describe, expect, it } from 'vitest';
import { parseScenario, resolveScenario, selectScenarios, applyTemplate, normalizeFlagValue, ScenarioError } from '../scenario/parse.js';

const YAML_SRC = `
id: video-resume
title: Lesson video resumes
tags: [smoke]
covers: ["Signed-in learner: watch ~40s"]
persona: learner
flags: { resume-playback: on }
fixtures: { lesson: intro }
setup:
  - id: reset
    api: { method: DELETE, url: "/api/progress/{{lesson}}" }
steps:
  - id: open
    chapter: Open
    goto: /lessons/{{lesson}}
    expect:
      - visible: { role: region, name: Lesson video }
  - id: return
    chapter: Return
    goto: /lessons/{{lesson}}
    expect:
      - media: { time: 42, tolerance: 3 }
  - chapter: Health
    expect:
      - console: { errors: 0 }
variants:
  - id: flag-off
    covers: ["Flag off"]
    flags: { resume-playback: off }
    override_last_expect:
      - media: { lte: 1 }
  - id: signed-out
    persona: anonymous
    skip_steps: [reset]
    override_steps:
      open: { chapter: Open signed out }
`;

describe('scenario parser', () => {
  it('parses YAML, keeps `on`/`off` as flags, and validates', () => {
    const s = parseScenario(YAML_SRC);
    expect(s.id).toBe('video-resume');
    expect(s.flags['resume-playback']).toBe('on');
    expect(s.steps).toHaveLength(3);
  });

  it('expands variants with overrides, templates and stable hashes', () => {
    const r = resolveScenario(parseScenario(YAML_SRC));
    expect(r.map((x) => x.key)).toEqual(['video-resume', 'video-resume/flag-off', 'video-resume/signed-out']);
    const [base, off, out] = r;
    expect(base!.flags).toEqual({ 'resume-playback': true });
    expect(base!.steps[0]!.goto).toBe('/lessons/intro');
    expect(base!.setup[0]!.api!.url).toBe('/api/progress/intro');
    // override_last_expect skips the console-only Health step
    expect(off!.flags['resume-playback']).toBe(false);
    expect(off!.steps[1]!.expect).toEqual([{ media: { lte: 1 } }]);
    expect(off!.steps[2]!.expect).toEqual([{ console: { errors: 0 } }]);
    expect(off!.covers).toEqual(['Flag off']);
    expect(out!.persona).toBe('anonymous');
    expect(out!.setup).toHaveLength(0);
    expect(out!.steps[0]!.chapter).toBe('Open signed out');
    expect(new Set(r.map((x) => x.hash)).size).toBe(3);
    expect(resolveScenario(parseScenario(YAML_SRC))[0]!.hash).toBe(base!.hash);
  });

  it('rejects unknown keys, bad ids and dangling variant step refs', () => {
    expect(() => parseScenario('id: x\ntitle: t\nsteps:\n  - gooto: /')).toThrow(ScenarioError);
    expect(() => parseScenario('id: "bad id!"\ntitle: t\nsteps:\n  - goto: /')).toThrow(/slug/);
    expect(() => parseScenario('id: x\ntitle: t\nsteps:\n  - goto: /\nvariants:\n  - id: v\n    skip_steps: [nope]')).toThrow(/unknown step id/);
    expect(() => parseScenario('id: x\ntitle: t\nsteps: []')).toThrow();
    expect(() => parseScenario('id: [')).toThrow(/invalid YAML/);
  });

  it('templates fixtures and env, and fails on unknown vars', () => {
    expect(applyTemplate('/a/{{x}}/{{env.HOME_X}}', { x: '1' }, { HOME_X: 'h' })).toBe('/a/1/h');
    expect(() => applyTemplate('{{missing}}', {})).toThrow(/unknown template/);
  });

  it('normalizes flag values', () => {
    expect(['on', 'true', 'yes', true].map(normalizeFlagValue)).toEqual([true, true, true, true]);
    expect(['off', 'false', 'no', false].map(normalizeFlagValue)).toEqual([false, false, false, false]);
    expect(normalizeFlagValue('variant-b')).toBe('variant-b');
  });

  it('selects by key, glob, scenario id and @tag', () => {
    const r = resolveScenario(parseScenario(YAML_SRC));
    expect(selectScenarios(r, ['video-resume']).length).toBe(3);
    expect(selectScenarios(r, ['video-resume/flag-off']).map((x) => x.key)).toEqual(['video-resume/flag-off']);
    expect(selectScenarios(r, ['*/signed-*']).map((x) => x.key)).toEqual(['video-resume/signed-out']);
    expect(selectScenarios(r, ['@smoke']).length).toBe(3);
    expect(selectScenarios(r, ['@nope']).length).toBe(0);
  });
});
