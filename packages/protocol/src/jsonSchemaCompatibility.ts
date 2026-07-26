export type JsonSchema = Record<string, unknown>;

export interface SchemaCompatibilityIssue {
  path: string;
  message: string;
}

/**
 * Conservative wire-compatibility check for generated Protocol schemas.
 *
 * Additive optional properties and new union variants are accepted. Removing
 * variants/properties/enum values, changing required fields, or narrowing
 * primitive constraints requires a new PROTOCOL_VERSION.
 */
export function findBreakingSchemaChanges(
  previous: JsonSchema,
  next: JsonSchema
): SchemaCompatibilityIssue[] {
  const issues: SchemaCompatibilityIssue[] = [];
  compareSchema(previous, next, '#', previous, next, issues);
  return issues;
}

function compareSchema(
  previous: unknown,
  next: unknown,
  path: string,
  previousRoot: JsonSchema,
  nextRoot: JsonSchema,
  issues: SchemaCompatibilityIssue[]
): void {
  const oldSchema = dereference(previous, previousRoot);
  const newSchema = dereference(next, nextRoot);
  if (!isObject(oldSchema) || !isObject(newSchema)) {
    return;
  }

  compareAllowedValues(oldSchema, newSchema, path, issues);
  compareType(oldSchema, newSchema, path, issues);
  compareNumericConstraint(
    oldSchema,
    newSchema,
    'minimum',
    path,
    (oldValue, newValue) => newValue > oldValue,
    issues
  );
  compareNumericConstraint(
    oldSchema,
    newSchema,
    'minLength',
    path,
    (oldValue, newValue) => newValue > oldValue,
    issues
  );
  compareNumericConstraint(
    oldSchema,
    newSchema,
    'maximum',
    path,
    (oldValue, newValue) => newValue < oldValue,
    issues
  );
  compareNumericConstraint(
    oldSchema,
    newSchema,
    'minItems',
    path,
    (oldValue, newValue) => newValue > oldValue,
    issues
  );
  compareNumericConstraint(
    oldSchema,
    newSchema,
    'maxItems',
    path,
    (oldValue, newValue) => newValue < oldValue,
    issues
  );
  compareStringConstraint(oldSchema, newSchema, 'pattern', path, issues);
  compareStringConstraint(oldSchema, newSchema, 'format', path, issues);
  compareNumericConstraint(
    oldSchema,
    newSchema,
    'maxLength',
    path,
    (oldValue, newValue) => newValue < oldValue,
    issues
  );

  const oldVariants = unionVariants(oldSchema, previousRoot);
  const newVariants = unionVariants(newSchema, nextRoot);
  if (oldVariants.length > 0) {
    compareVariants(
      oldVariants,
      newVariants,
      path,
      previousRoot,
      nextRoot,
      issues
    );
    return;
  }

  compareObject(
    oldSchema,
    newSchema,
    path,
    previousRoot,
    nextRoot,
    issues
  );

  if ('items' in oldSchema) {
    if (!('items' in newSchema)) {
      issues.push({ path, message: '数组 items 约束被移除' });
    } else {
      compareSchema(
        oldSchema.items,
        newSchema.items,
        `${path}/items`,
        previousRoot,
        nextRoot,
        issues
      );
    }
  }
}

function compareVariants(
  previous: JsonSchema[],
  next: JsonSchema[],
  path: string,
  previousRoot: JsonSchema,
  nextRoot: JsonSchema,
  issues: SchemaCompatibilityIssue[]
): void {
  const oldByDiscriminator = new Map(
    previous.flatMap((schema, index) => {
      const discriminator = discriminatorValue(schema, previousRoot);
      return discriminator
        ? [[discriminator, schema] as const]
        : [[`#${index}`, schema] as const];
    })
  );
  const nextByDiscriminator = new Map(
    next.flatMap((schema, index) => {
      const discriminator = discriminatorValue(schema, nextRoot);
      return discriminator
        ? [[discriminator, schema] as const]
        : [[`#${index}`, schema] as const];
    })
  );
  for (const [key, oldVariant] of oldByDiscriminator) {
    const newVariant = nextByDiscriminator.get(key);
    if (!newVariant) {
      issues.push({ path: `${path}/${key}`, message: '联合类型分支被移除' });
      continue;
    }
    compareSchema(
      oldVariant,
      newVariant,
      `${path}/${key}`,
      previousRoot,
      nextRoot,
      issues
    );
  }
}

function compareObject(
  previous: JsonSchema,
  next: JsonSchema,
  path: string,
  previousRoot: JsonSchema,
  nextRoot: JsonSchema,
  issues: SchemaCompatibilityIssue[]
): void {
  const oldProperties = isObject(previous.properties)
    ? previous.properties
    : undefined;
  if (!oldProperties) return;
  const newProperties = isObject(next.properties) ? next.properties : {};
  for (const [name, oldProperty] of Object.entries(oldProperties)) {
    if (!(name in newProperties)) {
      issues.push({
        path: `${path}/properties/${name}`,
        message: '字段被移除'
      });
      continue;
    }
    compareSchema(
      oldProperty,
      newProperties[name],
      `${path}/properties/${name}`,
      previousRoot,
      nextRoot,
      issues
    );
  }

  const oldRequired = stringSet(previous.required);
  const newRequired = stringSet(next.required);
  for (const name of new Set([...oldRequired, ...newRequired])) {
    if (oldRequired.has(name) !== newRequired.has(name)) {
      issues.push({
        path: `${path}/required/${name}`,
        message: '字段 required 状态发生变化'
      });
    }
  }
  if (
    previous.additionalProperties !== false &&
    next.additionalProperties === false
  ) {
    issues.push({ path, message: '对象开始拒绝未知字段' });
  }
}

function compareAllowedValues(
  previous: JsonSchema,
  next: JsonSchema,
  path: string,
  issues: SchemaCompatibilityIssue[]
): void {
  const oldValues = allowedValues(previous);
  const newValues = allowedValues(next);
  if (!oldValues && newValues) {
    issues.push({ path, message: '新增 enum/const 允许值限制' });
    return;
  }
  if (!oldValues || !newValues) return;
  for (const value of oldValues) {
    if (!newValues.some((candidate) => Object.is(candidate, value))) {
      issues.push({
        path,
        message: `允许值被移除：${JSON.stringify(value)}`
      });
    }
  }
}

function compareType(
  previous: JsonSchema,
  next: JsonSchema,
  path: string,
  issues: SchemaCompatibilityIssue[]
): void {
  const oldTypes = stringSet(
    Array.isArray(previous.type) ? previous.type : [previous.type]
  );
  const newTypes = stringSet(Array.isArray(next.type) ? next.type : [next.type]);
  if (oldTypes.size === 0 && newTypes.size > 0) {
    issues.push({ path, message: '新增 JSON 类型限制' });
    return;
  }
  if (oldTypes.size === 0 || newTypes.size === 0) return;
  for (const type of oldTypes) {
    if (!newTypes.has(type)) {
      issues.push({ path, message: `允许类型被移除：${type}` });
    }
  }
}

function compareNumericConstraint(
  previous: JsonSchema,
  next: JsonSchema,
  key:
    | 'minimum'
    | 'maximum'
    | 'minLength'
    | 'maxLength'
    | 'minItems'
    | 'maxItems',
  path: string,
  isNarrower: (oldValue: number, newValue: number) => boolean,
  issues: SchemaCompatibilityIssue[]
): void {
  const oldValue = previous[key];
  const newValue = next[key];
  if (typeof oldValue !== 'number' && typeof newValue === 'number') {
    issues.push({ path, message: `新增 ${key} 约束：${newValue}` });
    return;
  }
  if (
    typeof oldValue === 'number' &&
    typeof newValue === 'number' &&
    isNarrower(oldValue, newValue)
  ) {
    issues.push({ path, message: `${key} 约束收紧：${oldValue} -> ${newValue}` });
  }
}

function compareStringConstraint(
  previous: JsonSchema,
  next: JsonSchema,
  key: 'pattern' | 'format',
  path: string,
  issues: SchemaCompatibilityIssue[]
): void {
  const oldValue = previous[key];
  const newValue = next[key];
  if (typeof newValue !== 'string') return;
  if (typeof oldValue !== 'string') {
    issues.push({ path, message: `新增 ${key} 约束：${newValue}` });
  } else if (oldValue !== newValue) {
    issues.push({
      path,
      message: `${key} 约束发生变化：${oldValue} -> ${newValue}`
    });
  }
}

function unionVariants(schema: JsonSchema, root: JsonSchema): JsonSchema[] {
  for (const key of ['anyOf', 'oneOf'] as const) {
    const value = schema[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => dereference(item, root))
        .filter(isObject);
    }
  }
  return [];
}

function discriminatorValue(
  schema: JsonSchema,
  root: JsonSchema
): string | undefined {
  const resolved = dereference(schema, root);
  if (!isObject(resolved) || !isObject(resolved.properties)) return undefined;
  const typeSchema = dereference(resolved.properties.type, root);
  if (!isObject(typeSchema) || typeof typeSchema.const !== 'string') {
    return undefined;
  }
  return typeSchema.const;
}

function dereference(schema: unknown, root: JsonSchema): unknown {
  if (!isObject(schema) || typeof schema.$ref !== 'string') return schema;
  if (!schema.$ref.startsWith('#/')) return schema;
  return schema.$ref
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>(
      (value, part) => (isObject(value) ? value[part] : undefined),
      root
    );
}

function allowedValues(schema: JsonSchema): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum;
  if ('const' in schema) return [schema.const];
  return undefined;
}

function stringSet(value: unknown): Set<string> {
  const values = Array.isArray(value) ? value : [];
  return new Set(
    values.filter((item): item is string => typeof item === 'string')
  );
}

function isObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
