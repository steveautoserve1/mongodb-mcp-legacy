import pkg from 'mongodb';

const { ObjectId } = pkg;

export function parseDatabaseName(uri) {
  const withoutProtocol = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const afterHosts = withoutProtocol.split('/')[1];
  if (!afterHosts) return '';
  return afterHosts.split('?')[0];
}

/**
 * Stage operators that write data ($out / $merge). These only occur as
 * stage-level operators, so they are checked at the stage level only.
 */
export const FORBIDDEN_WRITE_STAGES = ['$out', '$merge'];
/**
 * Operators that execute server-side JavaScript. $function can appear
 * nested inside any stage's expression, so it is blocked at any depth.
 */
export const FORBIDDEN_EXPRESSION_OPERATORS = ['$function'];
/** All operators rejected by this read-only server (for documentation). */
export const FORBIDDEN_PIPELINE_STAGES = [
  ...FORBIDDEN_WRITE_STAGES,
  ...FORBIDDEN_EXPRESSION_OPERATORS,
];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  // Excludes BSON types (ObjectId/Date/RegExp) and other class instances.
  return proto === Object.prototype || proto === null;
}

function containsForbiddenKey(value, forbidden) {
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenKey(item, forbidden));
  }
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (forbidden.includes(key)) return true;
    if (containsForbiddenKey(value[key], forbidden)) return true;
  }
  return false;
}

/**
 * Validate an aggregation pipeline for the read-only guarantee.
 * Throws if the pipeline is not an array of stage objects, if any stage
 * uses a write-capable operator ($out/$merge), or if any operator in the
 * pipeline executes server-side JavaScript ($function, at any depth).
 */
export function validatePipeline(pipeline) {
  if (!Array.isArray(pipeline)) {
    throw new Error('Pipeline must be a JSON array');
  }
  for (let index = 0; index < pipeline.length; index++) {
    const stage = pipeline[index];
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new Error(`Pipeline stage ${index} must be an object`);
    }
    const forbiddenStage = FORBIDDEN_WRITE_STAGES.filter((s) => s in stage);
    if (forbiddenStage.length > 0) {
      throw new Error(
        `Pipeline stage ${index} uses forbidden stage operator(s) ` +
          `${forbiddenStage.join(', ')}. This server is read-only: stages ` +
          'that write data are not allowed.'
      );
    }
    if (containsForbiddenKey(stage, FORBIDDEN_EXPRESSION_OPERATORS)) {
      throw new Error(
        `Pipeline stage ${index} uses the forbidden operator $function. ` +
          'This server is read-only: stages that execute server-side ' +
          'JavaScript are not allowed.'
      );
    }
  }
  return pipeline;
}

/**
 * Validate a limit argument: non-negative integer, clamped to `cap`.
 * undefined/null falls back to `fallback`.
 */
export function parseLimit(value, fallback, cap) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('limit must be a non-negative integer');
  }
  return Math.min(value, cap);
}

/**
 * Validate a skip argument: non-negative integer.
 * undefined/null falls back to 0.
 */
export function parseSkip(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('skip must be a non-negative integer');
  }
  return value;
}

export function transformQuery(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(transformQuery);
  }

  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const key = keys[0];
    if (key === '$oid') {
      return new ObjectId(obj[key]);
    }
    if (key === '$date') {
      return new Date(obj[key]);
    }
  }

  if (keys.length >= 1 && keys.length <= 2 && '$regex' in obj) {
    return new RegExp(obj['$regex'], obj['$options'] || undefined);
  }

  // Null-prototype object so user-supplied "__proto__"/"constructor" keys
  // become plain own properties instead of hitting prototype setters.
  const result = Object.create(null);
  for (const key of keys) {
    result[key] = transformQuery(obj[key]);
  }
  return result;
}

export function parseQuery(queryString) {
  if (!queryString) return {};
  try {
    const parsed = JSON.parse(queryString);
    return transformQuery(parsed);
  } catch {
    throw new Error(
      `Invalid JSON query: ${queryString}. Ensure the query is valid JSON.`
    );
  }
}

export function sanitizeError(message) {
  return message.replace(
    /mongodb(\+srv)?:\/\/[^/\s]+@/gi,
    'mongodb$1://***:***@'
  );
}
