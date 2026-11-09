import pkg from 'mongodb';

const { ObjectId } = pkg;

export function parseDatabaseName(uri) {
  const withoutProtocol = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const afterHosts = withoutProtocol.split('/')[1];
  if (!afterHosts) return '';
  const rawName = afterHosts.split('?')[0];
  // The driver percent-decodes the database segment; decode it the same
  // way so the scope name matches the database the driver actually opens
  // (fall back to the raw segment on a malformed percent-escape).
  try {
    return decodeURIComponent(rawName);
  } catch {
    return rawName;
  }
}

/**
 * Stage operators that write data ($out / $merge). These only occur as
 * stage-level operators, so they are checked at the stage level only.
 */
export const FORBIDDEN_WRITE_STAGES = ['$out', '$merge'];
/**
 * Aggregation expression operators that execute server-side JavaScript.
 * $function (all versions) and $accumulator (MongoDB 4.2+) both accept
 * JavaScript code strings and can appear nested at any depth, so both
 * are blocked at any depth.
 */
export const FORBIDDEN_EXPRESSION_OPERATORS = ['$function', '$accumulator'];
/**
 * Query operators that execute server-side JavaScript. $where evaluates
 * a JavaScript expression per document (with access to the db object),
 * so it is rejected in every user-supplied filter and, as defense in
 * depth, inside pipeline stages.
 */
export const FORBIDDEN_QUERY_OPERATORS = ['$where'];
/** All operators rejected by this read-only server (for documentation). */
export const FORBIDDEN_PIPELINE_STAGES = [
  ...FORBIDDEN_WRITE_STAGES,
  ...FORBIDDEN_EXPRESSION_OPERATORS,
  ...FORBIDDEN_QUERY_OPERATORS,
];
/** Hard cap on the number of stages a single pipeline may contain. */
export const MAX_PIPELINE_STAGES = 100;
/**
 * $regex option flags this server supports end-to-end. MongoDB accepts
 * i/m/s/x, but x (extended mode) cannot round-trip through a JS RegExp,
 * so only i/m/s are offered.
 */
export const SUPPORTED_REGEX_OPTIONS = ['i', 'm', 's'];

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
 * Throws if the pipeline is not an array of stage objects, if it exceeds
 * MAX_PIPELINE_STAGES, if any stage uses a write-capable operator
 * ($out/$merge), or if any stage contains an operator that executes
 * server-side JavaScript ($function/$accumulator at any depth, $where).
 */
export function validatePipeline(pipeline) {
  if (!Array.isArray(pipeline)) {
    throw new Error('Pipeline must be a JSON array');
  }
  if (pipeline.length > MAX_PIPELINE_STAGES) {
    throw new Error(
      `Pipeline has ${pipeline.length} stages; maximum allowed is ` +
        `${MAX_PIPELINE_STAGES}`
    );
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
    const forbiddenExpressions = FORBIDDEN_EXPRESSION_OPERATORS.filter((op) =>
      containsForbiddenKey(stage, [op])
    );
    if (forbiddenExpressions.length > 0) {
      throw new Error(
        `Pipeline stage ${index} uses forbidden operator` +
          `${forbiddenExpressions.length > 1 ? 's' : ''} ` +
          `${forbiddenExpressions.join(', ')}. This server is read-only: ` +
          'stages that execute server-side JavaScript are not allowed.'
      );
    }
    if (containsForbiddenKey(stage, FORBIDDEN_QUERY_OPERATORS)) {
      throw new Error(
        `Pipeline stage ${index} uses the forbidden operator $where. ` +
          'Server-side JavaScript execution is disabled on this server.'
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
 * Validate a skip argument: non-negative integer, no larger than `maxSkip`
 * (when provided). undefined/null falls back to 0.
 */
export function parseSkip(value, maxSkip) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('skip must be a non-negative integer');
  }
  if (maxSkip !== undefined && value > maxSkip) {
    throw new Error(`skip exceeds the maximum of ${maxSkip}`);
  }
  return value;
}

function isSupportedRegexOptions(options) {
  if (typeof options !== 'string') return false;
  const seen = new Set();
  for (const flag of options) {
    if (!SUPPORTED_REGEX_OPTIONS.includes(flag) || seen.has(flag)) {
      return false;
    }
    seen.add(flag);
  }
  return true;
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
    // Absent/null $options means "no flags" (valid); a present but
    // unsupported value (non-string, or flags outside i/m/s) is an error.
    const rawOptions = obj['$options'];
    const options =
      rawOptions === undefined || rawOptions === null ? '' : rawOptions;
    if (!isSupportedRegexOptions(options)) {
      const shown = JSON.stringify(rawOptions).slice(0, 60);
      throw new Error(
        `Unsupported $options ${shown}. ` +
          `Supported flags: ${SUPPORTED_REGEX_OPTIONS.join(', ')} ` +
          '(each at most once). Extended mode (x) is not supported.'
      );
    }
    return new RegExp(obj['$regex'], options || undefined);
  }

  // Null-prototype object so user-supplied "__proto__"/"constructor" keys
  // become plain own properties instead of hitting prototype setters.
  const result = Object.create(null);
  for (const key of keys) {
    result[key] = transformQuery(obj[key]);
  }
  return result;
}

/**
 * Reject any occurrence of a forbidden query operator (e.g. $where)
 * anywhere in a parsed value, at any nesting depth.
 */
function rejectForbiddenQueryOperators(value) {
  for (const op of FORBIDDEN_QUERY_OPERATORS) {
    if (containsForbiddenKey(value, [op])) {
      throw new Error(
        `Operator ${op} is not allowed: server-side JavaScript execution ` +
          'is disabled on this server.'
      );
    }
  }
}

export function parseQuery(queryString) {
  if (!queryString) return {};
  let parsed;
  try {
    parsed = JSON.parse(queryString);
  } catch {
    throw new Error(
      `Invalid JSON query: ${queryString}. Ensure the query is valid JSON.`
    );
  }
  const transformed = transformQuery(parsed);
  rejectForbiddenQueryOperators(transformed);
  return transformed;
}

/**
 * Reject a string argument longer than `maxLength` (non-strings pass
 * through; type validation happens downstream).
 */
export function assertBoundedString(name, value, maxLength) {
  if (typeof value === 'string' && value.length > maxLength) {
    throw new Error(
      `Argument "${name}" is ${value.length} characters long; ` +
        `maximum allowed is ${maxLength}`
    );
  }
}

/**
 * Truncate an unbounded value list (e.g. distinct results) to `cap`,
 * reporting how many values were hidden.
 */
export function capValues(values, cap) {
  if (values.length <= cap) {
    return { values, note: null };
  }
  return {
    values: values.slice(0, cap),
    note:
      `showing first ${cap} of ${values.length} values (raise ` +
      'MONGODB_MCP_MAX_DISTINCT to see more)',
  };
}

/**
 * True when an error is a MongoDB authorization/permission failure (as
 * opposed to a network, timeout, or other failure). Used to decide when
 * the scoped-database fallback in list_databases is appropriate.
 */
export function isAuthorizationError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 13 || error.codeName === 'Unauthorized') return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return /not authorized|unauthorized|requires authentication/i.test(message);
}

export function sanitizeError(message) {
  if (typeof message !== 'string') return String(message);
  // Credential redaction in a single pass. Alternative order matters: the
  // scheme-prefixed form (greedy to the LAST '@', so passwords containing
  // '/', '@', etc. are fully redacted) is tried before the bare
  // user:***@host form, so the two shapes cannot re-match each other's
  // output. Which alternative fired is detected from the matched text
  // (a URI match starts with "mongodb" and contains "://").
  const credentials =
    /mongodb(?:\+srv)?:\/\/.*@|\b[A-Za-z0-9._%-]+:[^@\s]{1,128}@/gi;
  return (
    message
      .replace(credentials, (match) =>
        match.startsWith('mongodb') && match.includes('://')
          ? match.replace(/:\/\/.*@/, '://***:***@')
          : '***:***@'
      )
      // Scrub IPv4 addresses (internal topology disclosure).
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 'x.x.x.x')
  );
}
