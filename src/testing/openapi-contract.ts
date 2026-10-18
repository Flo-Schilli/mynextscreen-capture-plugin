// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../paths.js';

type Ajv2020Class = typeof import('ajv/dist/2020.js').default;
const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020').default as Ajv2020Class;

interface SchemaRef {
  $ref?: string;
}
interface Operation {
  requestBody?: { content: { 'application/json': { schema: SchemaRef } } };
  responses: Record<
    string,
    { $ref?: string; content?: { 'application/json': { schema: SchemaRef } } }
  >;
}
interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, Operation | unknown>>;
  components: {
    schemas: Record<string, unknown>;
    responses: Record<string, Operation['responses'][string]>;
  };
}

export const openApiDocument = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'openapi.json'), 'utf8'),
) as OpenApiDocument;

const ROOT_ID = 'https://capture-plugin.invalid/openapi.json';

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
ajv.addSchema({ ...openApiDocument, $id: ROOT_ID });

/** Path template of a concrete request path, e.g. `/v1/streams/<uuid>` to `/v1/streams/{streamId}`. */
export function templateFor(path: string): string {
  return path.replace(/^\/v1\/streams\/[^/]+$/, '/v1/streams/{streamId}');
}

function operation(method: string, path: string): Operation {
  const op = openApiDocument.paths[templateFor(path)]?.[method.toLowerCase()];
  if (!op) {
    throw new Error(`openapi.json does not document ${method} ${path}`);
  }
  return op as Operation;
}

function validateAgainst(schema: SchemaRef | undefined, value: unknown, what: string): void {
  const name = schema?.$ref?.split('/').pop();
  if (!name) {
    throw new Error(`${what}: schema is not a component reference`);
  }
  const validate = ajv.getSchema(`${ROOT_ID}#/components/schemas/${name}`);
  if (!validate) {
    throw new Error(`${what}: unknown schema ${name}`);
  }
  if (!validate(value)) {
    throw new Error(`${what} violates ${name}: ${ajv.errorsText(validate.errors)}`);
  }
}

/** Throws when the response is not documented or its body does not match the documented schema. */
export function assertResponseMatches(
  method: string,
  rawPath: string,
  status: number,
  body: unknown,
): void {
  const path = rawPath.split('?')[0] ?? rawPath;
  // Unknown routes and wrong methods have no operation; they use the shared responses.
  const shared = { 404: 'NotFound', 405: 'MethodNotAllowed' }[status];
  const documented = openApiDocument.paths[templateFor(path)]?.[method.toLowerCase()]
    ? (operation(method, path).responses[String(status)] ?? undefined)
    : undefined;
  const reference = documented?.$ref ?? (shared ? `#/components/responses/${shared}` : undefined);
  const response = reference
    ? openApiDocument.components.responses[reference.split('/').pop() ?? '']
    : documented;
  if (!response) {
    throw new Error(`${method} ${path} answered ${status}, which openapi.json does not document`);
  }
  const schema = response.content?.['application/json'].schema;
  if (!schema) {
    if (body !== undefined) {
      throw new Error(`${method} ${path} ${status} must have no body`);
    }
    return;
  }
  validateAgainst(schema, body, `${method} ${path} ${status}`);
}

/** True when the documented request body schema accepts the value. */
export function requestBodyIsValid(method: string, path: string, body: unknown): boolean {
  const schema = operation(method, path).requestBody?.content['application/json'].schema;
  try {
    validateAgainst(schema, body, `${method} ${path} request`);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes(' violates ')) {
      return false;
    }
    throw error;
  }
}
