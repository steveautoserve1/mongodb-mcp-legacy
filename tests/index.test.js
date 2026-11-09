import { describe, it, expect } from 'vitest';
import pkg from 'mongodb';
import {
  parseDatabaseName,
  parseLimit,
  parseQuery,
  parseSkip,
  sanitizeError,
  transformQuery,
  validatePipeline,
} from '../lib/utils.js';

const { ObjectId } = pkg;

describe('parseDatabaseName', () => {
  it('extracts database name from simple URI', () => {
    expect(parseDatabaseName('mongodb://localhost:27017/mydb')).toBe('mydb');
  });

  it('extracts database name from URI with query params', () => {
    expect(
      parseDatabaseName('mongodb://localhost:27017/mydb?retryWrites=true')
    ).toBe('mydb');
  });

  it('extracts database name from URI with credentials', () => {
    expect(parseDatabaseName('mongodb://user:pass@host:27017/testdb')).toBe(
      'testdb'
    );
  });

  it('handles URI with multiple hosts (replica set)', () => {
    expect(
      parseDatabaseName(
        'mongodb://host1:27017,host2:27017/repldb?replicaSet=rs0'
      )
    ).toBe('repldb');
  });

  it('returns empty string for URI without database path', () => {
    expect(parseDatabaseName('mongodb://localhost:27017')).toBe('');
  });

  it('returns empty string for URI with trailing slash but no database', () => {
    expect(parseDatabaseName('mongodb://localhost:27017/')).toBe('');
  });

  it('handles mongodb+srv:// URIs', () => {
    expect(
      parseDatabaseName('mongodb+srv://user:pass@cluster.example.com/proddb')
    ).toBe('proddb');
  });

  it('handles mongodb+srv:// URI without database', () => {
    expect(
      parseDatabaseName('mongodb+srv://user:pass@cluster.example.com')
    ).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(parseDatabaseName('')).toBe('');
  });
});

describe('parseQuery', () => {
  it('returns empty object for undefined input', () => {
    expect(parseQuery(undefined)).toEqual({});
  });

  it('returns empty object for null input', () => {
    expect(parseQuery(null)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseQuery('')).toEqual({});
  });

  it('parses valid JSON query', () => {
    expect(parseQuery('{"status": "active"}')).toEqual({ status: 'active' });
  });

  it('parses complex nested query', () => {
    expect(parseQuery('{"age": {"$gt": 18}, "status": "active"}')).toEqual({
      age: { $gt: 18 },
      status: 'active',
    });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseQuery('{invalid}')).toThrow('Invalid JSON query');
  });

  it('throws on malformed JSON with descriptive message', () => {
    expect(() => parseQuery('not json at all')).toThrow(
      'Ensure the query is valid JSON'
    );
  });
});

describe('transformQuery', () => {
  it('converts $oid to ObjectId', () => {
    const result = transformQuery({ $oid: '507f1f77bcf86cd799439011' });
    expect(result).toBeInstanceOf(ObjectId);
    expect(result.toString()).toBe('507f1f77bcf86cd799439011');
  });

  it('converts $date string to Date', () => {
    const result = transformQuery({ $date: '2024-01-01T00:00:00Z' });
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('converts $date number (timestamp) to Date', () => {
    const result = transformQuery({ $date: 1704067200000 });
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('transforms nested query with ObjectId and Date', () => {
    const result = transformQuery({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      createdAt: { $date: '2024-01-01T00:00:00Z' },
      status: 'active',
    });
    expect(result._id).toBeInstanceOf(ObjectId);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.status).toBe('active');
  });

  it('transforms values inside arrays', () => {
    const result = transformQuery({
      _id: {
        $in: [
          { $oid: '507f1f77bcf86cd799439011' },
          { $oid: '507f1f77bcf86cd799439012' },
        ],
      },
    });
    expect(result._id.$in[0]).toBeInstanceOf(ObjectId);
    expect(result._id.$in[1]).toBeInstanceOf(ObjectId);
  });

  it('converts $regex to RegExp without options', () => {
    const result = transformQuery({ $regex: '^hello' });
    expect(result).toBeInstanceOf(RegExp);
    expect(result.source).toBe('^hello');
    expect(result.flags).toBe('');
  });

  it('converts $regex with $options to RegExp', () => {
    const result = transformQuery({ $regex: 'hello', $options: 'i' });
    expect(result).toBeInstanceOf(RegExp);
    expect(result.source).toBe('hello');
    expect(result.flags).toBe('i');
  });

  it('transforms nested query with $regex', () => {
    const result = transformQuery({
      name: { $regex: 'john', $options: 'i' },
      status: 'active',
    });
    expect(result.name).toBeInstanceOf(RegExp);
    expect(result.name.test('John')).toBe(true);
    expect(result.status).toBe('active');
  });

  it('preserves normal objects unchanged', () => {
    const obj = { status: 'active', count: { $gt: 5 } };
    expect(transformQuery(obj)).toEqual(obj);
  });

  it('returns primitives as-is', () => {
    expect(transformQuery('string')).toBe('string');
    expect(transformQuery(42)).toBe(42);
    expect(transformQuery(null)).toBe(null);
  });

  it('transforms aggregation pipeline array', () => {
    const pipeline = transformQuery([
      {
        $match: { status: 'active', _id: { $oid: '507f1f77bcf86cd799439011' } },
      },
      { $group: { _id: '$category', total: { $sum: 1 } } },
    ]);
    expect(pipeline[0].$match.status).toBe('active');
    expect(pipeline[0].$match._id).toBeInstanceOf(ObjectId);
    expect(pipeline[1].$group._id).toBe('$category');
  });
});

describe('parseQuery', () => {
  it('returns empty object for undefined input', () => {
    expect(parseQuery(undefined)).toEqual({});
  });

  it('returns empty object for null input', () => {
    expect(parseQuery(null)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseQuery('')).toEqual({});
  });

  it('parses valid JSON query', () => {
    expect(parseQuery('{"status": "active"}')).toEqual({ status: 'active' });
  });

  it('parses complex nested query', () => {
    expect(parseQuery('{"age": {"$gt": 18}, "status": "active"}')).toEqual({
      age: { $gt: 18 },
      status: 'active',
    });
  });

  it('converts $oid in JSON query to ObjectId', () => {
    const result = parseQuery('{"_id": {"$oid": "507f1f77bcf86cd799439011"}}');
    expect(result._id).toBeInstanceOf(ObjectId);
    expect(result._id.toString()).toBe('507f1f77bcf86cd799439011');
  });

  it('converts $date in JSON query to Date', () => {
    const result = parseQuery(
      '{"createdAt": {"$date": "2024-01-01T00:00:00Z"}}'
    );
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('converts $regex in JSON query to RegExp', () => {
    const result = parseQuery('{"name": {"$regex": "john", "$options": "i"}}');
    expect(result.name).toBeInstanceOf(RegExp);
    expect(result.name.test('John')).toBe(true);
  });

  it('parses aggregation pipeline array', () => {
    const result = parseQuery(
      '[{"$match": {"status": "active"}}, {"$group": {"_id": "$category"}}]'
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].$match.status).toBe('active');
    expect(result[1].$group._id).toBe('$category');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseQuery('{invalid}')).toThrow('Invalid JSON query');
  });

  it('throws on malformed JSON with descriptive message', () => {
    expect(() => parseQuery('not json at all')).toThrow(
      'Ensure the query is valid JSON'
    );
  });
});

describe('sanitizeError', () => {
  it('redacts credentials from mongodb:// URI', () => {
    const msg = 'failed to connect to mongodb://admin:secretpass@host:27017/db';
    expect(sanitizeError(msg)).toBe(
      'failed to connect to mongodb://***:***@host:27017/db'
    );
  });

  it('redacts credentials from mongodb+srv:// URI', () => {
    const msg = 'error: mongodb+srv://user:p%40ss@cluster.example.com/db';
    expect(sanitizeError(msg)).toBe(
      'error: mongodb+srv://***:***@cluster.example.com/db'
    );
  });

  it('leaves messages without URIs unchanged', () => {
    const msg = 'Collection not found';
    expect(sanitizeError(msg)).toBe('Collection not found');
  });
});

describe('validatePipeline', () => {
  it('accepts a plain read-only pipeline', () => {
    const pipeline = [
      { $match: { status: 'active' } },
      { $group: { _id: '$category', total: { $sum: 1 } } },
    ];
    expect(validatePipeline(pipeline)).toBe(pipeline);
  });

  it('accepts an empty pipeline', () => {
    expect(validatePipeline([])).toEqual([]);
  });

  it('rejects a non-array pipeline', () => {
    expect(() => validatePipeline({ $match: {} })).toThrow(
      'Pipeline must be a JSON array'
    );
  });

  it('rejects non-object stages', () => {
    expect(() => validatePipeline(['not a stage'])).toThrow(
      'Pipeline stage 0 must be an object'
    );
    expect(() => validatePipeline([null])).toThrow(
      'Pipeline stage 0 must be an object'
    );
  });

  it('rejects $out stages', () => {
    expect(() => validatePipeline([{ $match: {} }, { $out: 'steal' }])).toThrow(
      'forbidden stage operator(s) $out'
    );
  });

  it('rejects $merge stages', () => {
    expect(() => validatePipeline([{ $merge: { into: 'steal' } }])).toThrow(
      'forbidden stage operator(s) $merge'
    );
  });

  it('rejects $function stages', () => {
    expect(() =>
      validatePipeline([{ $project: { x: { $function: { body: '1' } } } }])
    ).toThrow('forbidden operator $function');
  });

  it('rejects $function at any nesting depth', () => {
    expect(() =>
      validatePipeline([
        {
          $addFields: {
            nested: {
              deep: { $function: { body: '1', args: [], lang: 'js' } },
            },
          },
        },
      ])
    ).toThrow('forbidden operator $function');
  });

  it('rejects fields literally named $function (security trade-off)', () => {
    expect(() => validatePipeline([{ $match: { $function: 'x' } }])).toThrow(
      'forbidden operator $function'
    );
  });

  it('allows field references named like forbidden stages', () => {
    // "$out" as a *field value* (field reference), not a stage operator.
    expect(() =>
      validatePipeline([{ $group: { _id: '$out', n: { $sum: 1 } } }])
    ).not.toThrow();
  });

  it('allows $merge nested inside an expression (stage-level only check)', () => {
    expect(() =>
      validatePipeline([{ $project: { odd: { $merge: 1 } } }])
    ).not.toThrow();
  });

  it('reports the offending stage index', () => {
    expect(() =>
      validatePipeline([{ $match: {} }, { $match: {} }, { $out: 'x' }])
    ).toThrow('Pipeline stage 2');
  });
});

describe('parseLimit', () => {
  it('returns the fallback for undefined/null', () => {
    expect(parseLimit(undefined, 10, 1000)).toBe(10);
    expect(parseLimit(null, 100, 1000)).toBe(100);
  });

  it('accepts zero explicitly', () => {
    expect(parseLimit(0, 10, 1000)).toBe(0);
  });

  it('clamps to the cap', () => {
    expect(parseLimit(5000, 10, 1000)).toBe(1000);
  });

  it('passes through valid values', () => {
    expect(parseLimit(42, 10, 1000)).toBe(42);
  });

  it('rejects negative values', () => {
    expect(() => parseLimit(-1, 10, 1000)).toThrow(
      'limit must be a non-negative integer'
    );
  });

  it('rejects non-integers', () => {
    expect(() => parseLimit(1.5, 10, 1000)).toThrow(
      'limit must be a non-negative integer'
    );
  });

  it('rejects non-numeric strings', () => {
    expect(() => parseLimit('10', 10, 1000)).toThrow(
      'limit must be a non-negative integer'
    );
  });
});

describe('parseSkip', () => {
  it('returns 0 for undefined/null', () => {
    expect(parseSkip(undefined)).toBe(0);
    expect(parseSkip(null)).toBe(0);
  });

  it('passes through valid values', () => {
    expect(parseSkip(7)).toBe(7);
  });

  it('rejects negative values', () => {
    expect(() => parseSkip(-3)).toThrow('skip must be a non-negative integer');
  });

  it('rejects non-integers', () => {
    expect(() => parseSkip(2.5)).toThrow('skip must be a non-negative integer');
  });
});

describe('transformQuery prototype safety', () => {
  it('does not pollute Object.prototype via __proto__ keys', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}}');
    const result = transformQuery(parsed);
    expect({}.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result) === null).toBe(true);
    expect(result.__proto__.polluted).toBe(true);
  });

  it('handles __proto__ nested in a query', () => {
    const result = transformQuery({
      status: 'active',
      nested: { __proto__: { polluted: true } },
    });
    expect({}.polluted).toBeUndefined();
    expect(result.status).toBe('active');
  });

  it('keeps constructor and toString keys as plain properties', () => {
    const result = transformQuery({ constructor: 'x', toString: 1 });
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(
      true
    );
    expect(result.constructor).toBe('x');
  });
});
