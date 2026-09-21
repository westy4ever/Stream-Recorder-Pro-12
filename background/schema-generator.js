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

function generateDataclass(schema) {
  if (!schema || schema.type === 'array') {
    return generateDataclassArray(schema);
  }
  
  let code = 'from dataclasses import dataclass\n';
  code += 'from typing import List, Optional, Any\n\n\n';
  code += `@dataclass\n`;
  code += `class ${schema.name}:\n`;
  
  for (const field of schema.fields) {
    const fieldType = field.type || 'Any';
    const defaultValue = getDefaultValue(field.sample, fieldType);
    const isOptional = field.sample === null || field.sample === undefined;
    
    if (isOptional) {
      code += `    ${field.name}: Optional[${fieldType}] = None\n`;
    } else if (defaultValue !== null) {
      code += `    ${field.name}: ${fieldType} = ${defaultValue}\n`;
    } else {
      code += `    ${field.name}: ${fieldType}\n`;
    }
  }
  
  // Add nested dataclasses
  for (const field of schema.fields) {
    if (field.nested && field.nested.type === 'object') {
      code += '\n\n' + generateDataclass(field.nested);
    }
  }
  
  return code;
}

function generateDataclassArray(schema) {
  if (!schema || !schema.items) return '';
  
  let code = 'from dataclasses import dataclass\n';
  code += 'from typing import List, Optional, Any\n\n\n';
  code += `@dataclass\n`;
  code += `class ${schema.name}:\n`;
  code += `    items: List[${schema.items.name || 'Any'}]\n`;
  
  if (schema.items) {
    code += '\n\n' + generateDataclass(schema.items);
  }
  
  return code;
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