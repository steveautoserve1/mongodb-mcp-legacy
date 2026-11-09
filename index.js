#!/usr/bin/env node

import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pkg from 'mongodb';
import {
  assertBoundedString,
  capValues,
  isAuthorizationError,
  parseDatabaseName,
  parseLimit,
  parseQuery,
  parseSkip,
  sanitizeError,
  validatePipeline,
} from './lib/utils.js';

const { MongoClient } = pkg;
const require = createRequire(import.meta.url);
const { version } = require('./package.json');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';

function positiveIntEnv(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Database the server is scoped to (from MONGODB_URI). */
const DEFAULT_DB_NAME = parseDatabaseName(MONGODB_URI);
/** When true, tools may address databases other than the URI database. */
const ALLOW_ALL_DATABASES =
  process.env.MONGODB_MCP_ALLOW_ALL_DATABASES === 'true';
/** Hard cap on how many documents a single call may return. */
const MAX_LIMIT = positiveIntEnv('MONGODB_MCP_MAX_LIMIT', 1000);
/** Hard cap on how many documents a single call may scan past (skip). */
const MAX_SKIP = positiveIntEnv('MONGODB_MCP_MAX_SKIP', 1000000);
/** Hard cap on the length (characters) of any single string argument. */
const MAX_INPUT_LENGTH = positiveIntEnv('MONGODB_MCP_MAX_INPUT_LENGTH', 65536);
/** Hard cap on how many distinct values a single call may return. */
const MAX_DISTINCT = positiveIntEnv('MONGODB_MCP_MAX_DISTINCT', 1000);
/** Server-side timeout (ms) applied to every operation. */
const MAX_TIME_MS = positiveIntEnv('MONGODB_MCP_MAX_TIME_MS', 10000);

let client = null;
let db = null;
let connectPromise = null;

/**
 * Connect (once). Concurrent callers share a single in-flight connect;
 * a failed connect clears the pending promise so later calls retry.
 */
function connectMongoDB() {
  if (client) return Promise.resolve({ client, db });
  if (!connectPromise) {
    connectPromise = (async () => {
      if (!DEFAULT_DB_NAME) {
        throw new Error(
          'MONGODB_URI must include a database name (e.g. mongodb://host:port/mydb)'
        );
      }
      const c = await MongoClient.connect(MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        connectTimeoutMS: 10000,
        serverSelectionTimeoutMS: 10000,
      });
      client = c;
      db = c.db(DEFAULT_DB_NAME);
      console.error(`Connected to MongoDB: ${DEFAULT_DB_NAME}`);
      return { client, db };
    })().catch((error) => {
      connectPromise = null;
      throw error;
    });
  }
  return connectPromise;
}

async function shutdown() {
  if (client) {
    await client.close();
    console.error('MongoDB connection closed');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** Reject with a timeout error if `promise` does not settle within `ms`. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const server = new Server(
  {
    name: 'mongodb-mcp-legacy',
    version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_databases',
        description:
          'List databases on the MongoDB server. By default only the MONGODB_URI database is reported (set MONGODB_MCP_ALLOW_ALL_DATABASES=true to enumerate all databases).',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'list_collections',
        description: 'List all collections in a database',
        inputSchema: {
          type: 'object',
          properties: {
            database: {
              type: 'string',
              description:
                'Database name (optional, uses default if not specified)',
            },
          },
          required: [],
        },
      },
      {
        name: 'execute_query',
        description: 'Execute a read-only query (find operation)',
        inputSchema: {
          type: 'object',
          properties: {
            database: {
              type: 'string',
              description:
                'Database name (optional, uses default if not specified)',
            },
            collection: {
              type: 'string',
              description: 'Collection name',
            },
            query: {
              type: 'string',
              description:
                'Query filter as JSON string. Supports MongoDB extended JSON: use {"$oid": "..."} for ObjectId, {"$date": "..."} for ISODate, and {"$regex": "...", "$options": "ims"} for regular expressions. The $where operator is rejected.',
            },
            sort: {
              type: 'string',
              description:
                'Sort specification as JSON string (e.g., {"createdAt": -1} or {"name": 1})',
            },
            skip: {
              type: 'number',
              description:
                'Number of documents to skip (default: 0, non-negative integer, hard-capped by MONGODB_MCP_MAX_SKIP, default 1000000)',
            },
            limit: {
              type: 'number',
              description:
                'Maximum number of documents to return (default: 10, non-negative integer, hard-capped at 1000)',
            },
          },
          required: ['collection'],
        },
      },
      {
        name: 'count_documents',
        description: 'Count documents matching a query',
        inputSchema: {
          type: 'object',
          properties: {
            database: {
              type: 'string',
              description:
                'Database name (optional, uses default if not specified)',
            },
            collection: {
              type: 'string',
              description: 'Collection name',
            },
            query: {
              type: 'string',
              description:
                'Query filter as JSON string. Supports MongoDB extended JSON: use {"$oid": "..."} for ObjectId and {"$date": "..."} for ISODate. The $where operator is rejected.',
            },
          },
          required: ['collection'],
        },
      },
      {
        name: 'distinct_values',
        description:
          'Get distinct values for a field in a collection (result capped by MONGODB_MCP_MAX_DISTINCT, default 1000, truncated with a note)',
        inputSchema: {
          type: 'object',
          properties: {
            database: {
              type: 'string',
              description:
                'Database name (optional, uses default if not specified)',
            },
            collection: {
              type: 'string',
              description: 'Collection name',
            },
            field: {
              type: 'string',
              description: 'Field name to get distinct values for',
            },
            query: {
              type: 'string',
              description:
                'Optional query filter as JSON string. Supports MongoDB extended JSON: use {"$oid": "..."} for ObjectId, {"$date": "..."} for ISODate, and {"$regex": "...", "$options": "ims"} for regular expressions. The $where operator is rejected.',
            },
          },
          required: ['collection', 'field'],
        },
      },
      {
        name: 'aggregate',
        description:
          'Execute a read-only aggregation pipeline on a collection. Write, code-execution, and $where operators ($out, $merge, $function, $accumulator, $where) are rejected. Pipelines are limited to 100 stages.',
        inputSchema: {
          type: 'object',
          properties: {
            database: {
              type: 'string',
              description:
                'Database name (optional, uses default if not specified)',
            },
            collection: {
              type: 'string',
              description: 'Collection name',
            },
            pipeline: {
              type: 'string',
              description:
                'Aggregation pipeline as JSON array string. Supports MongoDB extended JSON: use {"$oid": "..."} for ObjectId, {"$date": "..."} for ISODate, and {"$regex": "...", "$options": "ims"} for regular expressions. Example: [{"$match": {"status": "active"}}, {"$group": {"_id": "$category", "total": {"$sum": 1}}}]',
            },
            limit: {
              type: 'number',
              description:
                'Maximum number of documents to return (default: 100, non-negative integer, hard-capped at 1000)',
            },
          },
          required: ['collection', 'pipeline'],
        },
      },
    ],
  };
});

function resolveDb(args) {
  if (args.database && args.database !== DEFAULT_DB_NAME) {
    if (!ALLOW_ALL_DATABASES) {
      throw new Error(
        `Database "${args.database}" is outside the configured scope ` +
          `(MONGODB_URI database is "${DEFAULT_DB_NAME}"). Set ` +
          'MONGODB_MCP_ALLOW_ALL_DATABASES=true to allow cross-database access.'
      );
    }
    return client.db(args.database);
  }
  return db;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  try {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    // Bound every string argument before it is parsed or sent to MongoDB.
    for (const key of [
      'database',
      'collection',
      'field',
      'query',
      'sort',
      'pipeline',
    ]) {
      assertBoundedString(key, args[key], MAX_INPUT_LENGTH);
    }

    await connectMongoDB();

    switch (name) {
      case 'list_databases': {
        if (!ALLOW_ALL_DATABASES) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  [
                    {
                      name: DEFAULT_DB_NAME,
                      note: 'scoped to the MONGODB_URI database; set MONGODB_MCP_ALLOW_ALL_DATABASES=true to list all databases',
                    },
                  ],
                  null,
                  2
                ),
              },
            ],
          };
        }
        try {
          const adminDb = client.db('admin').admin();
          const result = await withTimeout(
            adminDb.listDatabases(),
            MAX_TIME_MS,
            'listDatabases'
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result.databases, null, 2),
              },
            ],
          };
        } catch (error) {
          // Only an authorization failure justifies the scoped fallback;
          // network/timeout errors must surface as errors to the client.
          if (!isAuthorizationError(error)) throw error;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  [
                    {
                      name: DEFAULT_DB_NAME,
                      note: 'fallback: admin privileges unavailable',
                    },
                  ],
                  null,
                  2
                ),
              },
            ],
          };
        }
      }

      case 'list_collections': {
        const targetDb = resolveDb(args);
        const collections = await targetDb
          .listCollections({}, { maxTimeMS: MAX_TIME_MS })
          .toArray();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(collections, null, 2),
            },
          ],
        };
      }

      case 'execute_query': {
        const targetDb = resolveDb(args);
        const collection = targetDb.collection(args.collection);
        const query = parseQuery(args.query);
        const limit = parseLimit(args.limit, 10, MAX_LIMIT);
        const skip = parseSkip(args.skip, MAX_SKIP);
        const sort = args.sort ? parseQuery(args.sort) : undefined;

        let results;
        if (limit === 0) {
          results = [];
        } else {
          let cursor = collection.find(query).maxTimeMS(MAX_TIME_MS);
          if (sort) cursor = cursor.sort(sort);
          if (skip) cursor = cursor.skip(skip);
          if (limit) cursor = cursor.limit(limit);
          results = await cursor.toArray();
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'count_documents': {
        const targetDb = resolveDb(args);
        const collection = targetDb.collection(args.collection);
        const query = parseQuery(args.query);
        const count = await collection.countDocuments(query, {
          maxTimeMS: MAX_TIME_MS,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Count: ${count}`,
            },
          ],
        };
      }

      case 'distinct_values': {
        const targetDb = resolveDb(args);
        const collection = targetDb.collection(args.collection);
        const query = parseQuery(args.query);
        const all = await collection.distinct(args.field, query, {
          maxTimeMS: MAX_TIME_MS,
        });
        const { values, note } = capValues(all, MAX_DISTINCT);
        const text = note
          ? `${JSON.stringify(values, null, 2)}\n\nNote: ${note}`
          : JSON.stringify(values, null, 2);
        return {
          content: [
            {
              type: 'text',
              text,
            },
          ],
        };
      }

      case 'aggregate': {
        const targetDb = resolveDb(args);
        const collection = targetDb.collection(args.collection);
        const pipeline = validatePipeline(parseQuery(args.pipeline));
        const limit = parseLimit(args.limit, 100, MAX_LIMIT);
        const results =
          limit === 0
            ? []
            : await collection
                .aggregate(pipeline)
                .maxTimeMS(MAX_TIME_MS)
                .limit(limit)
                .toArray();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${sanitizeError(error.message)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MongoDB MCP Legacy Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', sanitizeError(error.message));
  process.exit(1);
});
