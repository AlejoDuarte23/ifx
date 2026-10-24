import type { IfcValue } from "./core.js";

export function flattenProperties(properties: IfcValue[], prefix = "", depth = 0): IfcValue[] {
  if (depth >= 16) return [];
  return properties.flatMap(property => {
    const name = prefix ? `${prefix}.${property.name}` : property.name;
    const current = { ...property, name };
    return property.details?.kind === "complex"
      ? [current, ...flattenProperties(property.details.properties, name, depth + 1)]
      : [current];
  });
}

export function propertySearchValues(property: IfcValue): string[] {
  const details = property.details;
  const values = [property.value];
  if (details?.kind === "list" || details?.kind === "enumerated") values.push(...details.values.map(value => value.value));
  if (details?.kind === "bounded") for (const value of [details.lower, details.upper, details.set_point]) if (value) values.push(value.value);
  if (details?.kind === "table") values.push(...details.defining.map(value => value.value), ...details.defined.map(value => value.value));
  if (details?.kind === "reference") values.push(String(details.express_id));
  return [...new Set(values)];
}
