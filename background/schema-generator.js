// schema-generator.js - API Response Schema Generation
import { state } from './state.js';

export function generateSchema(sampleData) {
  if (!sampleData) return null;

  // Parse JSON if string
  let data = sampleData;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (e) {
      return null;
    }
  }

  // Generate Python dataclass
  const schema = analyzeObject(data, 'Response');
  return {
    dataclass: generateDataclass(schema),
    jsonSchema: generateJsonSchema(schema),
    parserCode: generateParserCode(schema)
  };
}

function analyzeObject(obj, name) {
  const schema = {
    name: name,
    type: 'object',
    fields: [],
    optional: false
  };

  if (Array.isArray(obj)) {
    schema.type = 'array';
    if (obj.length > 0) {
      schema.items = analyzeObject(obj[0], name + 'Item');
    }
    return schema;
  }

  if (typeof obj !== 'object' || obj === null) {
    return {
      name: name,
      type: typeof obj,
      value: obj,
      optional: false
    };
  }

  for (const [key, value] of Object.entries(obj)) {
    const field = {
      name: key,
      type: getFieldType(value),
      optional: false,
      sample: value
    };

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      field.nested = analyzeObject(value, key.charAt(0).toUpperCase() + key.slice(1));
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      field.nested = analyzeObject(value[0], key.charAt(0).toUpperCase() + key.slice(1));
      field.type = 'List[' + field.nested.name + ']';
    }

    schema.fields.push(field);
  }

  return schema;
}

function getFieldType(value) {
  if (value === null) return 'Optional[Any]';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'List[Any]';
    return 'List[' + getFieldType(value[0]) + ']';
  }
  if (typeof value === 'object') return 'dict';
  if (typeof value === 'string') {
    if (value.match(/^\d{4}-\d{2}-\d{2}/)) return 'datetime';
    if (value.match(/^https?:\/\//)) return 'str'; // URL
    return 'str';
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return 'int';
    return 'float';
  }
  if (typeof value === 'boolean') return 'bool';
  return 'Any';
}

// [FIX] generateDataclass used to always prepend its own "from dataclasses import
// dataclass\nfrom typing import ..." header AND append nested dataclasses AFTER its own class
// body -- two compounding problems for any schema with nested objects/arrays (extremely
// common: {"movies": [...]} is exactly this shape). Confirmed directly against real Python:
// (1) a nested class referenced in a type annotation (e.g. "movies: List[MoviesItem]") but
// defined further down in the file throws NameError, since Python evaluates annotations
// eagerly at class-definition time; (2) recursing per nested level meant the import header
// got duplicated once per nesting depth. Restructured to collect nested class code FIRST via
// an isTopLevel parameter, emit it before this class's own body, and only emit the import
// header once, at the outermost call.
function generateDataclass(schema, isTopLevel = true) {
  if (!schema || schema.type === 'array') {
    return generateDataclassArray(schema, isTopLevel);
  }

  let nestedCode = '';
  for (const field of schema.fields) {
    if (field.nested && field.nested.type === 'object') {
      nestedCode += generateDataclass(field.nested, false) + '\n\n';
    }
  }

  let classCode = `@dataclass\n`;
  classCode += `class ${schema.name}:\n`;

  for (const field of schema.fields) {
    const fieldType = field.type || 'Any';
    const isOptional = field.sample === null || field.sample === undefined;

    if (isOptional) {
      // [FIX] getFieldType(null) already returns 'Optional[Any]' -- wrapping it in another
      // Optional[...] here produced a redundant, confusing "Optional[Optional[Any]]". Only
      // wrap if the type isn't already Optional-wrapped.
      const optionalType = fieldType.startsWith('Optional[') ? fieldType : `Optional[${fieldType}]`;
      classCode += `    ${field.name}: ${optionalType} = None\n`;
    } else {
      const defaultValue = getDefaultValue(field.sample, fieldType);
      if (defaultValue !== null) {
        classCode += `    ${field.name}: ${fieldType} = ${defaultValue}\n`;
      } else {
        // [FIX] Python dataclasses require every field AFTER the first field with a default
        // to also have a default, or class definition itself throws
        // "TypeError: non-default argument '...' follows default argument" -- confirmed
        // directly. Fields here come from Object.entries() on a real API response, in
        // whatever arbitrary order that response happens to use, so a defaulted field
        // (e.g. a simple int) followed by a non-defaulted one (e.g. a nested List[...] type,
        // which getDefaultValue() has no case for) broke on any real-world response shaped
        // that way. Giving every field a default (as an Optional) sidesteps the ordering
        // requirement entirely, rather than needing to reorder fields and lose their
        // original, readable order.
        classCode += `    ${field.name}: Optional[${fieldType}] = None\n`;
      }
    }
  }

  if (isTopLevel) {
    let header = 'from dataclasses import dataclass\n';
    header += 'from typing import List, Optional, Any\n\n\n';
    return header + nestedCode + classCode;
  }
  return nestedCode + classCode;
}

function generateDataclassArray(schema, isTopLevel = true) {
  if (!schema || !schema.items) return '';

  let itemsCode = '';
  if (schema.items) {
    itemsCode = generateDataclass(schema.items, false) + '\n\n';
  }

  let classCode = `@dataclass\n`;
  classCode += `class ${schema.name}:\n`;
  classCode += `    items: List[${schema.items.name || 'Any'}]\n`;

  if (isTopLevel) {
    let header = 'from dataclasses import dataclass\n';
    header += 'from typing import List, Optional, Any\n\n\n';
    return header + itemsCode + classCode;
  }
  return itemsCode + classCode;
}

function getDefaultValue(sample, type) {
  if (sample === null || sample === undefined) return null;
  if (type === 'str') return `"${sample}"`;
  if (type === 'int' || type === 'float') return String(sample);
  if (type === 'bool') return sample ? 'True' : 'False';
  if (type === 'List') return '[]';
  if (type === 'dict') return '{}';
  return null;
}

function generateJsonSchema(schema) {
  if (!schema) return null;

  const jsonSchema = {
    '$schema': 'http://json-schema.org/draft-07/schema#',
    'type': 'object',
    'properties': {},
    'required': []
  };

  for (const field of schema.fields) {
    jsonSchema.properties[field.name] = {
      'type': getJsonSchemaType(field.type || 'Any'),
      'description': `Sample: ${JSON.stringify(field.sample)}`
    };

    if (field.nested) {
      jsonSchema.properties[field.name]['items'] = {
        'type': 'object',
        'properties': {}
      };
    }

    if (field.sample !== null && field.sample !== undefined) {
      jsonSchema.required.push(field.name);
    }
  }

  return JSON.stringify(jsonSchema, null, 2);
}

function getJsonSchemaType(type) {
  if (type.includes('str')) return 'string';
  if (type.includes('int')) return 'integer';
  if (type.includes('float')) return 'number';
  if (type.includes('bool')) return 'boolean';
  if (type.includes('List')) return 'array';
  if (type.includes('dict') || type.includes('object')) return 'object';
  return 'string';
}

function generateParserCode(schema) {
  if (!schema) return '';

  let code = 'def parse_response(data):\n';
  code += '    """Parse API response into dataclass."""\n';
  code += '    if not data:\n';
  code += '        return None\n';
  code += '    \n';
  code += `    return ${schema.name}(\n`;

  for (const field of schema.fields) {
    const fieldName = field.name;
    if (field.nested && field.nested.type === 'object') {
      code += `        ${fieldName}=parse_${fieldName}(data.get("${fieldName}", {})),\n`;
    } else if (field.type && field.type.startsWith('List')) {
      code += `        ${fieldName}=data.get("${fieldName}", []),\n`;
    } else if (field.type === 'datetime') {
      code += `        ${fieldName}=datetime.fromisoformat(data.get("${fieldName}")) if data.get("${fieldName}") else None,\n`;
    } else {
      code += `        ${fieldName}=data.get("${fieldName}"),\n`;
    }
  }

  code += '    )\n';

  return code;
}

export function generateSchemaReport() {
  const s = state;
  const xhrBodies = s.xhrBodies || [];

  let report = '=== API RESPONSE SCHEMAS ===\n\n';

  // Find JSON responses
  const jsonBodies = xhrBodies.filter(b =>
    b.contentType === 'json' ||
    (b.body && b.body.trim().startsWith('{')) ||
    (b.body && b.body.trim().startsWith('['))
  );

  for (const body of jsonBodies.slice(0, 5)) {
    try {
      const data = JSON.parse(body.body);
      const schema = generateSchema(data);

      if (schema) {
        report += `📡 ${body.url || 'Unknown API'}\n`;
        report += `   Method: ${body.method || 'GET'}\n`;
        report += `   Status: ${body.status || 200}\n`;
        report += `\n${schema.dataclass}\n`;
        report += `\nJSON Schema:\n${schema.jsonSchema}\n`;
        report += `\nParser:\n${schema.parserCode}\n`;
        report += '\n' + '='.repeat(50) + '\n\n';
      }
    } catch (e) {
      // Not valid JSON
    }
  }

  return report;
}
