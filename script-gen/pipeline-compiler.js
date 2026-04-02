// === pipeline-compiler.js ===
/**
 * @module pipeline-compiler
 * @description Compiles a pipeline JSON recipe into an AST suitable for
 *   consumption by the script emitters (Python, Node, Lua).
 *   Also validates the pipeline structure and resolves step references.
 *
 * @dependencies logger
 */

import { logger } from '../utils/logger.js';

const MODULE = 'pipeline-compiler';

/**
 * Compile and validate a pipeline recipe into an AST.
 * @param {object} recipe - Raw pipeline JSON
 * @returns {{ ast: object, errors: string[] }}
 */
export function compilePipeline(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== 'object') {
    return { ast: null, errors: ['Pipeline must be an object'] };
  }
  if (!Array.isArray(recipe.steps)) {
    return { ast: null, errors: ['Pipeline must have a steps array'] };
  }

  const steps = recipe.steps.map((step, i) => {
    if (!step.type) errors.push(`Step ${i + 1} is missing a type`);
    return {
      id:     step.id ?? `step_${i + 1}`,
      type:   (step.type ?? '').toUpperCase(),
      label:  step.label ?? step.type ?? `Step ${i + 1}`,
      config: step.config ?? {},
    };
  });

  const ast = {
    name:         recipe.name ?? 'Untitled',
    version:      recipe.version ?? '3.0.0',
    targetOrigin: recipe.targetOrigin ?? '',
    steps,
    meta: {
      compiledAt: new Date().toISOString(),
      stepCount:  steps.length,
    },
  };

  logger.info(MODULE, 'compiled', { name: ast.name, steps: steps.length, errors: errors.length });
  return { ast, errors };
}

/**
 * Serialize a pipeline to a safe shareable JSON string.
 * Strips any sensitive config values (proxy credentials, API keys).
 * @param {object} pipeline
 * @returns {string}
 */
export function serializePipeline(pipeline) {
  const REDACT = /pass(word)?|secret|token|key|cred|auth/i;
  const sanitize = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (REDACT.test(k)) out[k] = '[REDACTED]';
      else if (typeof v === 'object') out[k] = sanitize(v);
      else out[k] = v;
    }
    return out;
  };
  return JSON.stringify(sanitize(pipeline), null, 2);
}

// === END pipeline-compiler.js ===
